import { z } from 'zod';
import { QueryFlagSchema } from './query';

/**
 * Voice input: on-device speech-to-text with Cactus Compute's Whistle. `GET /api/transcribe/status` says which engine runs
 * and whether the model file is on disk; `POST /api/transcribe/model` (an explicit click, with `accept: true`) downloads it; `POST /api/transcribe`
 * takes audio and answers the text; `POST /api/transcribe/stream` does the same as server-sent events with partial text; the `live` routes take
 * 16 kHz PCM while the user is still speaking.
 */

/** The languages Whistle knows (English, German, French, Spanish, Italian, Dutch, Polish). */
export const SPEECH_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'] as const;
export const SpeechLanguageSchema = z.enum(SPEECH_LANGUAGES);
export type SpeechLanguage = z.infer<typeof SpeechLanguageSchema>;

/** `auto` lets the model detect the language. */
export const TranscribeLanguageSchema = z.union([z.literal('auto'), SpeechLanguageSchema]);
export type TranscribeLanguage = z.infer<typeof TranscribeLanguageSchema>;

export const SPEECH_LANGUAGE_NAMES: Record<SpeechLanguage, string> = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pl: 'Polish' };

/** Which engine runs the model: the needle WASM build in a worker thread, the Python `needle` package, or the test engine. */
export const TRANSCRIBE_ENGINES = ['wasm', 'python', 'fake', 'none'] as const;
export const TranscribeEngineSchema = z.enum(TRANSCRIBE_ENGINES);
export type TranscribeEngineName = z.infer<typeof TranscribeEngineSchema>;

export const TranscribeModelSchema = z.object({
  name: z.string(),
  file: z.string(),
  /** The pinned size and SHA-256 of the file; a download that differs is thrown away. */
  bytes: z.number(),
  sha256: z.string(),
  /** Where "Download" fetches it from. */
  source: z.string(),
  license: z.string(),
  state: z.enum(['missing', 'downloading', 'ready', 'error']),
  receivedBytes: z.number().optional(),
  /** Why the last download or load failed. */
  error: z.string().optional(),
  /** Where the file is (or will be) on disk. */
  path: z.string(),
});
export type TranscribeModel = z.infer<typeof TranscribeModelSchema>;

export const TranscribeStatusSchema = z.object({
  engine: TranscribeEngineSchema,
  /** A sentence for Settings: what runs the model, or why nothing does. */
  note: z.string(),
  model: TranscribeModelSchema,
  /** `wav` is always on; `ffmpeg` decodes other formats (WebM/Opus, Ogg, MP4) when the program is installed. */
  decoders: z.object({ ffmpeg: z.boolean() }),
  /** The Python `needle` package was found (the fallback engine); null while nobody had to look. */
  python: z.object({ available: z.boolean().nullable() }),
  languages: z.array(SpeechLanguageSchema),
  /** Whether a model is loaded in memory right now (the first request loads it). */
  loaded: z.boolean(),
}).meta({ id: 'TranscribeStatus' });
export type TranscribeStatus = z.infer<typeof TranscribeStatusSchema>;

export const DownloadModelSchema = z.object({ accept: z.literal(true) }).meta({ id: 'DownloadModel' });

export const TranscribeWordSchema = z.object({ word: z.string(), start: z.number(), end: z.number(), probability: z.number() });
export type TranscribeWord = z.infer<typeof TranscribeWordSchema>;

export const TranscribeResultSchema = z.object({
  text: z.string(),
  /** The detected (or forced) language; empty for silence. */
  language: z.union([z.literal(''), SpeechLanguageSchema]),
  /** Length of the audio. */
  durationMs: z.number(),
  /** How long the backend took, from the request to the text. */
  tookMs: z.number(),
  words: z.array(TranscribeWordSchema).optional(),
}).meta({ id: 'TranscribeResult' });
export type TranscribeResult = z.infer<typeof TranscribeResultSchema>;

/**
 * One server-sent event of a streaming transcription. `partial` carries the newly committed words (`text`, append it with a space) and the
 * unconfirmed tail (`pending`, replace the last one); `done` the whole result; `error` why it stopped.
 */
export const TranscribeStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('partial'), text: z.string(), pending: z.string(), receivedSeconds: z.number() }),
  z.object({ type: z.literal('done'), result: TranscribeResultSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
]).meta({ id: 'TranscribeStreamEvent' });
export type TranscribeStreamEvent = z.infer<typeof TranscribeStreamEventSchema>;

/** The largest recording the backend accepts (a WAV of about half an hour at 16 kHz). */
export const TRANSCRIBE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The text of a streaming transcription so far. `committed` pieces are final and appended with a space; `pending` is the engine's
 * unconfirmed tail and is replaced by every update.
 */
export interface TranscriptSoFar {
  committed: string[];
  pending: string;
}

export const emptyTranscript = (): TranscriptSoFar => ({ committed: [], pending: '' });

/** Applies one `partial` event: its words are committed, its tail replaces the previous one. */
export function mergePartial(so: TranscriptSoFar, event: { text: string; pending: string }): TranscriptSoFar {
  const text = event.text.trim();
  return { committed: text ? [...so.committed, text] : so.committed, pending: event.pending.trim() };
}

/** The whole text so far, the way it is shown while the user is still speaking and inserted when they stop. */
export function transcriptText(so: TranscriptSoFar): string {
  return [...so.committed, so.pending]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** One server-sent event as it came off the wire. */
export interface SseMessage {
  event: string;
  data: string;
}

/**
 * An incremental parser of a server-sent-events body: feed it the decoded chunks as they arrive (a chunk may end anywhere, even between `\r` and
 * `\n`); `onMessage` gets each complete event. Comment lines (`:`) and unknown fields are ignored, several `data:` lines join with a newline.
 */
export function createSseParser(onMessage: (message: SseMessage) => void): { push(chunk: string): void; end(): void } {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const line = (text: string): void => {
    if (text === '') {
      if (data.length > 0) onMessage({ event, data: data.join('\n') });
      event = 'message';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  const drain = (final: boolean): void => {
    let match = /\r\n|\n|\r/.exec(buffer);
    while (match) {
      // A lone "\r" at the very end may be the first half of "\r\n": wait for the next chunk.
      if (match[0] === '\r' && match.index === buffer.length - 1 && !final) return;
      line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      match = /\r\n|\n|\r/.exec(buffer);
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      drain(false);
    },
    end() {
      drain(true);
      if (buffer) line(buffer);
      buffer = '';
      line('');
    },
  };
}

/** `?language=` and `?words=` of the transcription routes. */
export const TranscribeLanguageQuerySchema = z.object({ language: z.string().optional() });
export const TranscribeQuerySchema = TranscribeLanguageQuerySchema.extend({ words: QueryFlagSchema.optional() });

/** `POST /api/transcribe/live`: the id of the live transcription that was started. */
export const LiveTranscriptionSchema = z.object({ id: z.string() }).meta({ id: 'LiveTranscription' });
export type LiveTranscription = z.infer<typeof LiveTranscriptionSchema>;
