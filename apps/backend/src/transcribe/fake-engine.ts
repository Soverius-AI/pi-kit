import { durationMs, peak } from './pcm';
import type { EngineChunk, EngineOptions, EngineResult, SpeechEngine } from './speech-engine';

/**
 * The engine of the tests (`PI_KIT_TRANSCRIBE_ENGINE=fake`, ignored when `NODE_ENV=production`): no model, no worker. It "hears" what it was
 * given and says so, which makes the PCM pipeline observable: the text names the length of the 16 kHz audio it received and whether it was
 * silent, so a test that feeds a WAV fixture through `POST /api/transcribe` proves that the file was parsed, downmixed and resampled.
 * Streaming commits one word per chunk, the way Whistle commits text a pass behind.
 */
export class FakeEngine implements SpeechEngine {
  readonly kind = 'fake' as const;

  private words(pcm: Float32Array, language: string | undefined): string[] {
    const seconds = (durationMs(pcm) / 1000).toFixed(1);
    return ['fixture', 'heard', `${seconds}`, 'seconds', peak(pcm) < 0.001 ? 'of silence' : 'of sound', ...(language ? [`in ${language}`] : [])];
  }

  async transcribe(pcm: Float32Array, options: EngineOptions = {}): Promise<EngineResult> {
    if (pcm.length === 0) return { text: '', language: '' };
    return { text: this.words(pcm, options.language).join(' ') + '.', language: options.language ?? 'en' };
  }

  async *stream(chunks: AsyncIterable<Float32Array>, options: EngineOptions = {}): AsyncGenerator<EngineChunk, void, void> {
    const lead = ['fixture', 'heard'];
    const all: Float32Array[] = [];
    let received = 0;
    let committed = 0;
    for await (const chunk of chunks) {
      all.push(chunk);
      received += chunk.length;
      // One of the first words is final with each chunk; the tail is only a guess.
      const text = lead[committed] ?? '';
      if (text) committed++;
      yield { text, pending: committed < lead.length ? `${lead.slice(committed).join(' ')} ...` : '...', language: options.language ?? 'en', receivedSeconds: received / 16000 };
    }
    const pcm = new Float32Array(received);
    let at = 0;
    for (const part of all) {
      pcm.set(part, at);
      at += part.length;
    }
    const rest = received ? this.words(pcm, options.language).slice(committed).join(' ') + '.' : '';
    yield { text: rest, pending: '', language: received ? (options.language ?? 'en') : '', receivedSeconds: received / 16000 };
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
