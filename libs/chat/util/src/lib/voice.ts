import type { Translate } from '@pi-kit/i18n';
import { canonicalCombo, type KeyEventLike } from '@pi-kit/ui';

/**
 * Voice input, the parts without a browser in them: the WAV the recorder's audio is sent as, the push-to-talk key (what
 * starts a recording, what ends it) and the words the hint row shows.
 */

/** Mono 16-bit PCM WAV bytes of float samples in [-1, 1] (clipped). This is what `POST /api/transcribe` takes from the composer. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data, true);
  writePcm16(view, 44, samples);
  return out;
}

/** 16-bit little-endian PCM of float samples, for the live route's chunks. */
export function floatToPcm16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  writePcm16(new DataView(out.buffer), 0, samples);
  return out;
}

function writePcm16(view: DataView, offset: number, samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset + i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
  }
}

/** Channels averaged to one (what `decodeAudioData` gives for a stereo microphone). */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0]?.length ?? 0);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] += channel[i] / channels.length;
  return out;
}

/**
 * Collects the small blocks an audio worklet delivers (128 samples at a time) into pieces of `size` samples: the live route gets about a second
 * at a time. `flush` hands over what is left, however short.
 */
export class Chunker {
  private parts: Float32Array[] = [];
  private held = 0;

  constructor(private readonly size: number) {}

  push(block: Float32Array): Float32Array[] {
    this.parts.push(block);
    this.held += block.length;
    const out: Float32Array[] = [];
    while (this.held >= this.size) {
      const all = this.take(this.size);
      out.push(all);
    }
    return out;
  }

  flush(): Float32Array | undefined {
    return this.held > 0 ? this.take(this.held) : undefined;
  }

  private take(count: number): Float32Array {
    const out = new Float32Array(count);
    let at = 0;
    while (at < count) {
      const head = this.parts[0];
      const need = count - at;
      if (head.length <= need) {
        out.set(head, at);
        at += head.length;
        this.parts.shift();
      } else {
        out.set(head.subarray(0, need), at);
        this.parts[0] = head.subarray(need);
        at += need;
      }
    }
    this.held -= count;
    return out;
  }
}

/** What a key press did to a push-to-talk key, given how it behaves (`hold`: speak while it is down; `toggle`: press to start, press to finish). */
export type PttAction = 'start' | 'stop' | 'none';
export interface PttState {
  /** A recording is running (started by the key or by the button). */
  recording: boolean;
}

/**
 * The push-to-talk decision, pure. `down` is the key combination going down (`repeat` is the operating system's auto-repeat, which never counts),
 * `up` the key being released (see `releasesCombo`), `blur` the window losing focus while the key is down (the release would never be seen).
 */
export function pushToTalk(
  mode: 'hold' | 'toggle',
  state: PttState,
  event: 'down' | 'up' | 'blur',
  repeat = false,
): PttAction {
  if (event === 'down') {
    if (repeat) return 'none';
    if (mode === 'hold') return state.recording ? 'none' : 'start';
    return state.recording ? 'stop' : 'start';
  }
  // A release or a blur ends a held recording; in toggle mode the recording goes on.
  if (mode === 'hold' && state.recording) return 'stop';
  return 'none';
}

const MODIFIER_KEYS: Record<string, string[]> = {
  alt: ['Alt', 'AltGraph'],
  shift: ['Shift'],
  ctrl: ['Control'],
  mod: ['Control', 'Meta'],
  super: ['Meta'],
};

/**
 * Does this key-up end a push-to-talk recording that `combo` started? Releasing the main key does, and so does letting go of one of the
 * combination's modifiers first (⌥ before Space), which a plain comparison of the combination would miss.
 */
export function releasesCombo(
  combo: string,
  started: Pick<KeyEventLike, 'code' | 'key'>,
  up: Pick<KeyEventLike, 'code' | 'key'>,
): boolean {
  if (up.code && started.code && up.code === started.code) return true;
  if (!up.code && up.key === started.key) return true;
  const parts = (canonicalCombo(combo) ?? '').split('+');
  parts.pop();
  return parts.some((mod) => MODIFIER_KEYS[mod]?.includes(up.key));
}

/** A recording shorter than this is a tap on the key, not speech. */
export const MIN_SPEECH_MS = 400;

/** `setup`: the first use, when the model is not on disk yet and the hint row asks whether to download it. */
export type VoicePhase = 'idle' | 'setup' | 'starting' | 'listening' | 'transcribing' | 'error';

/** The hint row's line for a phase. `key` is the push-to-talk key as drawn, e.g. `⌥Space`. */
export function voiceHint(
  translate: Translate,
  phase: VoicePhase,
  opts: {
    key: string;
    mode: 'hold' | 'toggle';
    byKey: boolean;
    partial?: string;
    error?: string;
    downloadPercent?: number;
    modelMb?: number;
  },
): string {
  switch (phase) {
    case 'setup':
      if (opts.downloadPercent !== undefined)
        return translate('chat.voice.downloadingWhistle', { value1: opts.downloadPercent });
      if (opts.error) return opts.error;
      return translate('chat.voice.voiceInputRunsWhistleOnThisMachine', { value1: opts.modelMb ?? 17 });
    case 'starting':
      return translate('chat.voice.startingTheMicrophone');
    case 'listening':
      if (opts.partial) return opts.partial;
      return opts.byKey && opts.mode === 'hold'
        ? translate('chat.voice.listeningReleaseToInsert', { value1: opts.key })
        : translate('chat.voice.listeningClickTheMicrophoneToFinish');
    case 'transcribing':
      return translate('chat.voice.transcribing');
    case 'error':
      return opts.error ?? translate('chat.voice.voiceInputFailed');
    default:
      return '';
  }
}
