import type { SpeechLanguage, TranscribeWord } from '@pi-kit/protocol';

/** What an engine answers for one piece of audio. `language` is empty for silence. */
export interface EngineResult {
  text: string;
  language: SpeechLanguage | '';
  words?: TranscribeWord[];
}

/** One update of a streaming transcription: the words committed by the chunk just fed, and the unconfirmed tail. */
export interface EngineChunk {
  text: string;
  pending: string;
  language: SpeechLanguage | '';
  receivedSeconds: number;
}

export interface EngineOptions {
  /** Omit to detect the language. */
  language?: SpeechLanguage;
  words?: boolean;
  signal?: AbortSignal;
}

/**
 * A speech-to-text engine. All input is 16 kHz mono floats; `transcribe` takes at most 30 seconds, `stream` any length in chunks
 * of about a second. The service serialises calls, so an engine may assume one at a time.
 */
export interface SpeechEngine {
  readonly kind: 'wasm' | 'python' | 'fake';
  transcribe(pcm: Float32Array, options?: EngineOptions): Promise<EngineResult>;
  stream(chunks: AsyncIterable<Float32Array>, options?: EngineOptions): AsyncGenerator<EngineChunk, void, void>;
  /** Releases the model (the worker thread, the child process). Safe to call twice. */
  close(): Promise<void>;
}

/** Whistle takes at most this much audio in one `transcribe` call; longer recordings go through `stream`. */
export const MAX_BATCH_SECONDS = 28;
