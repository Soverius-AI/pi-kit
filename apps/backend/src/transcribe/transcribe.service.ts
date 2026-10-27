import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  emptyTranscript,
  mergePartial,
  SPEECH_LANGUAGES,
  type SpeechLanguage,
  type TranscribeResult,
  type TranscribeStatus,
  type TranscribeStreamEvent,
  transcriptText,
} from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { AsyncQueue, Mutex } from './async-queue';
import { decodeAudio, findFfmpeg } from './audio-decode';
import { FakeEngine } from './fake-engine';
import { ModelStore } from './model-store';
import { needleAvailable, NeedleEngine } from './needle-engine';
import { chunked, durationMs, peak, pcm16ToFloat, WHISTLE_RATE } from './pcm';
import { findPythonWithNeedle, PythonEngine } from './python-engine';
import { MAX_BATCH_SECONDS, type SpeechEngine } from './speech-engine';

/** Audio shorter than this has nothing to transcribe (and Whistle makes words up from clicks). */
const MIN_SAMPLES = Math.round(WHISTLE_RATE * 0.15);
/** A recording this quiet is silence; the model is not asked. */
const SILENCE_PEAK = 0.0008;
/** The model is released after this long without a request (the file stays; the next request loads it again in about 100 ms). */
const IDLE_CLOSE_MS = 10 * 60_000;
/** A live session nobody has sent audio to for this long is dropped, so it cannot hold the engine. */
const LIVE_IDLE_MS = 30_000;

const fakeAllowed = (): boolean => process.env['PI_KIT_TRANSCRIBE_ENGINE'] === 'fake' && process.env['NODE_ENV'] !== 'production';

export const parseLanguage = (value: string | undefined): SpeechLanguage | undefined => ((SPEECH_LANGUAGES as readonly string[]).includes(value ?? '') ? (value as SpeechLanguage) : undefined);

interface Live {
  id: string;
  queue: AsyncQueue<Float32Array>;
  events: TranscribeStreamEvent[];
  listeners: Set<(event: TranscribeStreamEvent) => void>;
  finished: Promise<TranscribeResult>;
  touched: number;
}

/**
 * Voice input on the backend: which engine runs Whistle and whether the model file is there, the consented download, and
 * the transcription of a recording (one request, server-sent partials, or live chunks while the user speaks). Calls are serialised: one
 * model, one request at a time. The model is loaded by the first request and released after ten idle minutes.
 */
@Injectable()
export class TranscribeService implements OnModuleDestroy {
  private readonly logger = new Logger(TranscribeService.name);
  readonly store: ModelStore;
  private readonly lock = new Mutex();
  private engine: SpeechEngine | undefined;
  private loadProblem: string | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly lives = new Map<string, Live>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(@Inject(CONFIG) config: BackendConfig) {
    this.store = new ModelStore(config.dataDir);
    this.sweep = setInterval(() => this.dropStaleLives(), 5000);
    this.sweep.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweep);
    clearTimeout(this.idle);
    for (const live of this.lives.values()) live.queue.end();
    await this.engine?.close();
  }

  // ---- status, download, removal

  status(): TranscribeStatus {
    const model = this.store.status();
    const ffmpeg = findFfmpeg() !== undefined;
    const common = { model, decoders: { ffmpeg }, languages: [...SPEECH_LANGUAGES], loaded: this.engine !== undefined };
    if (fakeAllowed()) return { ...common, engine: 'fake', note: 'The test engine (PI_KIT_TRANSCRIBE_ENGINE=fake): it reports what it received instead of what was said.', python: { available: null } };
    if (this.engine?.kind === 'python') return { ...common, engine: 'python', note: `Using the Python needle package (${this.loadProblem ?? 'the WASM engine did not start'}). No live partials in this mode.`, python: { available: true } };
    if (this.loadProblem) {
      const python = findPythonWithNeedle();
      return python
        ? { ...common, engine: 'python', note: `The WASM engine could not start (${this.loadProblem}). The Python needle package will be used.`, python: { available: true } }
        : { ...common, engine: 'none', note: `The WASM engine could not start (${this.loadProblem}) and the Python needle package (pip install cactus-needle) was not found.`, python: { available: false } };
    }
    if (needleAvailable()) return { ...common, engine: 'wasm', note: 'Runs in this app: the needle WebAssembly build in a worker thread, on the CPU. Nothing is sent anywhere.', python: { available: null } };
    return { ...common, engine: 'none', note: 'The cactus-needle package is not installed with this build.', python: { available: null } };
  }

  /** Starts the download the user asked for and returns at once; `status()` shows the progress. */
  startDownload(): TranscribeStatus {
    if (this.store.present && !this.store.busy) return this.status();
    // A failed download is reported through the status; nobody awaits this promise.
    this.store.download().catch((error: Error) => this.logger.warn(`Whistle download failed: ${error.message}`));
    return this.status();
  }

  async removeModel(): Promise<TranscribeStatus> {
    for (const live of this.lives.values()) live.queue.end();
    await this.closeEngine();
    this.store.remove();
    this.loadProblem = undefined;
    return this.status();
  }

  // ---- one recording

  async transcribe(audio: Uint8Array, language: SpeechLanguage | undefined, words = false): Promise<TranscribeResult> {
    const started = performance.now();
    const pcm = await decodeAudio(audio);
    return this.transcribePcm(pcm, language, started, words);
  }

  /** Server-sent events for a recording: a `partial` for each second the engine has heard, then `done` (or `error`). */
  async *streamRecording(audio: Uint8Array, language: SpeechLanguage | undefined): AsyncGenerator<TranscribeStreamEvent, void, void> {
    const started = performance.now();
    try {
      const pcm = await decodeAudio(audio);
      if (pcm.length < MIN_SAMPLES || peak(pcm) < SILENCE_PEAK) {
        yield { type: 'done', result: this.empty(pcm, started) };
        return;
      }
      const { engine, release } = await this.acquireEngine();
      try {
        let so = emptyTranscript();
        let detected: TranscribeResult['language'] = '';
        for await (const part of engine.stream(this.feed(chunked(pcm)), { ...(language ? { language } : {}) })) {
          so = mergePartial(so, part);
          detected = part.language || detected;
          yield { type: 'partial', text: part.text, pending: part.pending, receivedSeconds: part.receivedSeconds };
        }
        yield { type: 'done', result: { text: transcriptText(so), language: detected, durationMs: durationMs(pcm), tookMs: Math.round(performance.now() - started) } };
      } finally {
        release();
      }
    } catch (error) {
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ---- live: audio arrives while the user is still speaking

  /** Opens a live session: the engine is reserved for it until `endLive` (or 30 s without audio). */
  async startLive(language: SpeechLanguage | undefined): Promise<{ id: string }> {
    for (const old of [...this.lives.values()]) this.abortLive(old.id);
    const { engine, release } = await this.acquireEngine();
    const started = performance.now();
    const queue = new AsyncQueue<Float32Array>();
    const live: Live = { id: randomUUID(), queue, events: [], listeners: new Set(), finished: Promise.resolve({ text: '', language: '', durationMs: 0, tookMs: 0 }), touched: Date.now() };
    const emit = (event: TranscribeStreamEvent): void => {
      live.events.push(event);
      for (const listener of live.listeners) listener(event);
    };
    live.finished = (async (): Promise<TranscribeResult> => {
      let so = emptyTranscript();
      let detected: TranscribeResult['language'] = '';
      let seconds = 0;
      try {
        for await (const part of engine.stream(queue, { ...(language ? { language } : {}) })) {
          so = mergePartial(so, part);
          detected = part.language || detected;
          seconds = part.receivedSeconds;
          emit({ type: 'partial', text: part.text, pending: part.pending, receivedSeconds: part.receivedSeconds });
        }
        const result: TranscribeResult = { text: transcriptText(so), language: detected, durationMs: Math.round(seconds * 1000), tookMs: Math.round(performance.now() - started) };
        emit({ type: 'done', result });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: 'error', message });
        throw error;
      } finally {
        queue.end();
        this.lives.delete(live.id);
        release();
      }
    })();
    live.finished.catch(() => undefined);
    this.lives.set(live.id, live);
    return { id: live.id };
  }

  /** 16-bit little-endian 16 kHz mono PCM of the next piece of speech. */
  pushLive(id: string, pcm16: Uint8Array): void {
    const live = this.live(id);
    live.touched = Date.now();
    if (pcm16.length > 1) live.queue.push(pcm16ToFloat(pcm16));
  }

  /** The user stopped: the engine flushes what it has not committed, and the whole result comes back. */
  async endLive(id: string): Promise<TranscribeResult> {
    const live = this.live(id);
    live.queue.end();
    return live.finished;
  }

  abortLive(id: string): void {
    this.lives.get(id)?.queue.end();
  }

  /** The events so far, then each new one, until the session ends; returns the unsubscribe function. */
  watchLive(id: string, listener: (event: TranscribeStreamEvent) => void): () => void {
    const live = this.live(id);
    for (const event of live.events) listener(event);
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  private live(id: string): Live {
    const live = this.lives.get(id);
    if (!live) throw new ConflictException('That live transcription is over or never started.');
    return live;
  }

  private dropStaleLives(): void {
    const now = Date.now();
    for (const live of this.lives.values()) if (now - live.touched > LIVE_IDLE_MS) live.queue.end();
  }

  // ---- the engine

  private empty(pcm: Float32Array, started: number): TranscribeResult {
    return { text: '', language: '', durationMs: durationMs(pcm), tookMs: Math.round(performance.now() - started) };
  }

  private async transcribePcm(pcm: Float32Array, language: SpeechLanguage | undefined, started: number, words: boolean): Promise<TranscribeResult> {
    if (pcm.length < MIN_SAMPLES || peak(pcm) < SILENCE_PEAK) return this.empty(pcm, started);
    const { engine, release } = await this.acquireEngine();
    try {
      if (pcm.length / WHISTLE_RATE <= MAX_BATCH_SECONDS) {
        const result = await engine.transcribe(pcm, { ...(language ? { language } : {}), ...(words ? { words } : {}) });
        return { text: result.text, language: result.language, durationMs: durationMs(pcm), tookMs: Math.round(performance.now() - started), ...(result.words ? { words: result.words } : {}) };
      }
      // Longer than one batch: the engine takes it as a stream.
      let so = emptyTranscript();
      let detected: TranscribeResult['language'] = '';
      for await (const part of engine.stream(this.feed(chunked(pcm)), { ...(language ? { language } : {}) })) {
        so = mergePartial(so, part);
        detected = part.language || detected;
      }
      return { text: transcriptText(so), language: detected, durationMs: durationMs(pcm), tookMs: Math.round(performance.now() - started) };
    } finally {
      release();
    }
  }

  private async *feed(chunks: Iterable<Float32Array>): AsyncGenerator<Float32Array, void, void> {
    for (const chunk of chunks) yield chunk;
  }

  /** Reserve the engine before loading it and stop disposal for the entire active request. */
  private async acquireEngine(): Promise<{ engine: SpeechEngine; release: () => void }> {
    const release = await this.lock.acquire();
    clearTimeout(this.idle);
    this.idle = undefined;
    try {
      if (!this.engine && !this.store.present) throw new ConflictException('Whistle is not downloaded. Settings › Voice has the “Download Whistle” button.');
      const engine = this.engine ?? await this.loadEngine();
      return {
        engine,
        release: () => {
          release();
          this.touch();
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async loadEngine(): Promise<SpeechEngine> {
    if (fakeAllowed()) return (this.engine = new FakeEngine());
    if (!(await this.store.verify())) {
      this.store.fail('The model file on disk does not match its SHA-256. Remove it and download it again.');
      throw new ConflictException(this.store.status().error);
    }
    this.loadProblem = undefined;
    if (needleAvailable()) {
      try {
        this.engine = await NeedleEngine.create(this.store.path);
        this.logger.log('Whistle loaded (needle WASM)');
        return this.engine;
      } catch (error) {
        this.loadProblem = error instanceof Error ? error.message : String(error);
        this.logger.warn(`The WASM engine could not start: ${this.loadProblem}`);
      }
    } else {
      this.loadProblem = 'the cactus-needle package is not installed';
    }
    const python = findPythonWithNeedle();
    if (python) {
      this.engine = new PythonEngine(python, this.store.path);
      this.logger.log(`Whistle through the Python needle package (${python})`);
      return this.engine;
    }
    throw new ConflictException(`No speech engine could start: ${this.loadProblem}. Install the Python package with “pip install cactus-needle” to use it instead.`);
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.closeEngine(), IDLE_CLOSE_MS);
    this.idle.unref();
  }

  private async closeEngine(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
    await engine?.close().catch(() => undefined);
  }
}
