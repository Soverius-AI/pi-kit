/**
 * Audio to what Whistle takes: 16 kHz mono float samples in [-1, 1]. Pure functions, no I/O: a WAV parser
 * (8/16/24/32-bit integers and 32/64-bit floats, any channel count and rate), a windowed-sinc resampler, and the conversions between
 * 16-bit little-endian PCM (what the live route receives) and floats.
 */

export const WHISTLE_RATE = 16_000;

/** Why audio could not be read; the controller turns it into a 4xx. */
export class AudioError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = 'AudioError';
  }
}

export interface MonoAudio {
  samples: Float32Array;
  sampleRate: number;
}

export type AudioFormat = 'wav' | 'webm' | 'ogg' | 'mp4' | 'mp3' | 'flac' | 'unknown';

/** The container by its first bytes (the `Content-Type` of a recorder is not always honest). */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat {
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') return 'mp4';
  if (bytes.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac';
  if (bytes.length >= 3 && (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'mp3';
  return 'unknown';
}

/** Reads a WAV file; channels are averaged to mono. The data chunk may be unsized (0 or 0xFFFFFFFF, as a streaming writer leaves it). */
export function parseWav(bytes: Uint8Array): MonoAudio {
  if (sniffAudioFormat(bytes) !== 'wav') throw new AudioError('Not a WAV file.', 415);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw new AudioError('The WAV header is damaged.');
      let tag = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (tag === 0xfffe && size >= 26) tag = view.getUint16(body + 24, true);
      format = { tag, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) throw new AudioError('The WAV file has data before its format.');
      if (size === 0 || size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
      return decodeFrames(view, body, size, format);
    }
    offset = body + size + (size % 2);
  }
  throw new AudioError('The WAV file has no audio data.');
}

function decodeFrames(view: DataView, start: number, size: number, f: { tag: number; channels: number; rate: number; bits: number }): MonoAudio {
  const { tag, channels, rate, bits } = f;
  if (channels < 1 || channels > 8) throw new AudioError(`A WAV file with ${channels} channels is not supported.`, 415);
  if (rate < 1000 || rate > 384_000) throw new AudioError(`A sample rate of ${rate} Hz is not supported.`, 415);
  const isFloat = tag === 3;
  if (!(tag === 1 || isFloat) || (isFloat ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits))) {
    throw new AudioError(`WAV format ${tag} with ${bits} bits is not supported; send 16-bit PCM.`, 415);
  }
  const width = bits / 8;
  const frames = Math.floor(size / (width * channels));
  const out = new Float32Array(frames);
  const sample = (at: number): number => {
    switch (bits) {
      case 8:
        return (view.getUint8(at) - 128) / 128;
      case 16:
        return view.getInt16(at, true) / 32768;
      case 24: {
        const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        return v / 8_388_608;
      }
      case 32:
        return isFloat ? view.getFloat32(at, true) : view.getInt32(at, true) / 2_147_483_648;
      default:
        return view.getFloat64(at, true);
    }
  };
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += sample(start + (i * channels + c) * width);
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate: rate };
}

const LOBES = 8;
const TABLE_STEPS = 256;
/** The windowed-sinc kernel on [-LOBES, LOBES] in steps of 1/TABLE_STEPS (a table, so a long recording does not call `sin` per tap). */
const KERNEL = (() => {
  const table = new Float32Array(2 * LOBES * TABLE_STEPS + 2);
  for (let i = 0; i < table.length; i++) {
    const x = i / TABLE_STEPS - LOBES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const hann = 0.5 * (1 + Math.cos((Math.PI * x) / LOBES));
    table[i] = sinc * hann;
  }
  return table;
})();

/**
 * Resamples with a windowed sinc (8 lobes, Hann window). Going down, the kernel is stretched by the ratio so that nothing above the new Nyquist
 * frequency folds back into the speech band (a plain linear interpolation of 48 kHz to 16 kHz would).
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  const stretch = Math.max(1, ratio);
  const radius = LOBES * stretch;
  for (let i = 0; i < length; i++) {
    const center = i * ratio;
    const first = Math.max(0, Math.ceil(center - radius));
    const last = Math.min(input.length - 1, Math.floor(center + radius));
    let sum = 0;
    let weights = 0;
    for (let k = first; k <= last; k++) {
      // Rounding at the edge of the window must not step outside the table.
      const position = Math.min(KERNEL.length - 2, Math.max(0, ((k - center) / stretch + LOBES) * TABLE_STEPS));
      const index = Math.floor(position);
      const weight = KERNEL[index] + (KERNEL[index + 1] - KERNEL[index]) * (position - index);
      sum += input[k] * weight;
      weights += weight;
    }
    out[i] = weights !== 0 ? sum / weights : 0;
  }
  return out;
}

/** Whistle's input from any mono audio. */
export function toWhistleRate(audio: MonoAudio): Float32Array {
  return resample(audio.samples, audio.sampleRate, WHISTLE_RATE);
}

/** 16-bit little-endian PCM (the live route's chunks) to floats. An odd trailing byte is dropped. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Floats to 16-bit little-endian PCM, clipped. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
  }
  return out;
}

/** Splits samples into chunks of `size` (the last one may be shorter). */
export function* chunked(samples: Float32Array, size = WHISTLE_RATE): Generator<Float32Array> {
  for (let at = 0; at < samples.length; at += size) yield samples.subarray(at, Math.min(samples.length, at + size));
}

/** The length of 16 kHz audio in milliseconds. */
export const durationMs = (samples: Float32Array): number => Math.round((samples.length / WHISTLE_RATE) * 1000);

/** The loudest sample, 0 for none. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]));
  return max;
}
