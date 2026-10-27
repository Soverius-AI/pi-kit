import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SpeechLanguage } from '@pi-kit/protocol';
import type { EngineChunk, EngineOptions, EngineResult, SpeechEngine } from './speech-engine';

/** The parts of `cactus-needle` this engine uses (the package is ESM with its own types; it is loaded by path, see `loadNeedle`). */
interface WhistleInstance {
  transcribe(audio: Float32Array, options?: { language?: SpeechLanguage; wordTimestamps?: boolean; abortSignal?: AbortSignal }): Promise<{
    text: string;
    language: SpeechLanguage | '';
    words?: { word: string; start: number; end: number; probability: number }[];
  }>;
  stream(
    chunks: AsyncIterable<Float32Array>,
    options?: { language?: SpeechLanguage; abortSignal?: AbortSignal },
  ): AsyncIterableIterator<{ text: string; pending: string; language: SpeechLanguage | ''; received: number }>;
  close(): Promise<void>;
}
interface NeedleModule {
  Whistle: new (options: { weights: string; download: false }) => WhistleInstance;
}

/**
 * `cactus-needle` is ESM-only and the backend is a CommonJS bundle, where a plain `import()` would be compiled to `require()`. As for pi
 * (`load-pi.ts`), the package is found the way Node finds it (`node_modules` upwards from this file) and loaded with a native `import()`.
 */
const nativeImport: <T>(specifier: string) => Promise<T> = process.env['VITEST']
  ? // vitest runs the module in a VM context, where a function made by `new Function` has no import callback; it handles `import()` itself.
    (specifier) => import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)
  : (new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>);

export function needleDir(from: string = __dirname): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const built = join(dir, 'assets', 'needle');
    if (existsSync(join(built, 'dist', 'index.js'))) return built;
    const candidate = join(dir, 'node_modules', 'cactus-needle');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

async function loadNeedle(): Promise<NeedleModule> {
  const dir = needleDir();
  if (!dir) throw new Error('The cactus-needle package is not installed (node_modules/cactus-needle).');
  return nativeImport<NeedleModule>(pathToFileURL(join(dir, 'dist', 'index.js')).href);
}

/** Whether the WASM engine's package is there, without loading it. */
export const needleAvailable = (): boolean => needleDir() !== undefined;

/**
 * Whistle through the needle WASM build in a worker thread (the community `cactus-needle` package, Apache-2.0): CPU only, no network. The
 * package never downloads here: it is given the path of the model file pi-kit fetched after the user agreed (`download: false`), and its worker
 * has `fetch` turned off. The first call loads the model in about a hundred milliseconds; later calls reuse it.
 */
export class NeedleEngine implements SpeechEngine {
  readonly kind = 'wasm' as const;
  private whistle: WhistleInstance | undefined;

  private constructor(private readonly modelPath: string) {}

  /** Starts the worker and loads the model; rejects if the package or the model cannot be loaded. */
  static async create(modelPath: string): Promise<NeedleEngine> {
    const engine = new NeedleEngine(modelPath);
    const { Whistle } = await loadNeedle();
    engine.whistle = new Whistle({ weights: modelPath, download: false });
    // The constructor loads lazily; a first tiny call makes a missing or broken model fail now, where the service can fall back.
    await engine.whistle.transcribe(new Float32Array(1600));
    return engine;
  }

  async transcribe(pcm: Float32Array, options: EngineOptions = {}): Promise<EngineResult> {
    const result = await this.engine().transcribe(pcm, {
      ...(options.language ? { language: options.language } : {}),
      ...(options.words ? { wordTimestamps: true } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    return { text: result.text.trim(), language: result.language, ...(result.words ? { words: result.words } : {}) };
  }

  async *stream(chunks: AsyncIterable<Float32Array>, options: EngineOptions = {}): AsyncGenerator<EngineChunk, void, void> {
    for await (const part of this.engine().stream(chunks, { ...(options.language ? { language: options.language } : {}), ...(options.signal ? { abortSignal: options.signal } : {}) })) {
      yield { text: part.text, pending: part.pending, language: part.language, receivedSeconds: part.received };
    }
  }

  async close(): Promise<void> {
    const whistle = this.whistle;
    this.whistle = undefined;
    await whistle?.close();
  }

  private engine(): WhistleInstance {
    if (!this.whistle) throw new Error(`The speech engine was closed (${this.modelPath}).`);
    return this.whistle;
  }
}
