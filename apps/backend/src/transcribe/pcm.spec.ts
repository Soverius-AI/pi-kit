import { describe, expect, it } from 'vitest';
import { wavFile } from './wav.testing';
import { AudioError, chunked, durationMs, floatToPcm16, parseWav, pcm16ToFloat, peak, resample, sniffAudioFormat, toWhistleRate, WHISTLE_RATE } from './pcm';

const int16 = (values: number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return out;
};

const sine = (hz: number, rate: number, seconds: number, amplitude = 0.5): Float32Array => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (s: Float32Array, from = 0, to = s.length): number => Math.sqrt(s.subarray(from, to).reduce((a, v) => a + v * v, 0) / (to - from));

describe('sniffAudioFormat', () => {
  it('knows the containers a recorder produces by their first bytes', () => {
    expect(sniffAudioFormat(wavFile(int16([0, 0])))).toBe('wav');
    expect(sniffAudioFormat(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]))).toBe('webm');
    expect(sniffAudioFormat(new TextEncoder().encode('OggS....'))).toBe('ogg');
    expect(sniffAudioFormat(Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0]))).toBe('mp4');
    expect(sniffAudioFormat(new TextEncoder().encode('hello world, not audio'))).toBe('unknown');
    expect(sniffAudioFormat(new Uint8Array(0))).toBe('unknown');
  });
});

describe('parseWav', () => {
  it('reads 16-bit mono PCM as floats in [-1, 1)', () => {
    const { samples, sampleRate } = parseWav(wavFile(int16([0, 16384, -16384, -32768, 32767])));
    expect(sampleRate).toBe(16000);
    expect(Array.from(samples)).toEqual([0, 0.5, -0.5, -1, 32767 / 32768]);
  });

  it('averages the channels of a stereo file', () => {
    const { samples } = parseWav(wavFile(int16([16384, -16384, 16384, 16384, 0, 0]), { channels: 2 }));
    expect(Array.from(samples)).toEqual([0, 0.5, 0]);
  });

  it('reads 8-bit unsigned, 24-bit, 32-bit integer and 32/64-bit float samples', () => {
    expect(Array.from(parseWav(wavFile(Uint8Array.from([128, 255, 0]), { bits: 8 })).samples)).toEqual([0, 127 / 128, -1]);
    expect(Array.from(parseWav(wavFile(Uint8Array.from([0, 0, 0x40, 0, 0, 0xc0]), { bits: 24 })).samples)).toEqual([0.5, -0.5]);
    const i32 = new Uint8Array(8);
    new DataView(i32.buffer).setInt32(0, 1 << 30, true);
    new DataView(i32.buffer).setInt32(4, -(1 << 30), true);
    expect(Array.from(parseWav(wavFile(i32, { bits: 32 })).samples)).toEqual([0.5, -0.5]);
    const f32 = new Uint8Array(8);
    new DataView(f32.buffer).setFloat32(0, 0.25, true);
    new DataView(f32.buffer).setFloat32(4, -0.75, true);
    expect(Array.from(parseWav(wavFile(f32, { bits: 32, tag: 3 })).samples)).toEqual([0.25, -0.75]);
    const f64 = new Uint8Array(8);
    new DataView(f64.buffer).setFloat64(0, 0.125, true);
    expect(Array.from(parseWav(wavFile(f64, { bits: 64, tag: 3 })).samples)).toEqual([0.125]);
  });

  it('follows WAVE_FORMAT_EXTENSIBLE to the real format, skips chunks it does not know and accepts an unsized data chunk', () => {
    const data = int16([16384, -16384]);
    expect(Array.from(parseWav(wavFile(data, { extensible: true })).samples)).toEqual([0.5, -0.5]);
    expect(Array.from(parseWav(wavFile(data, { extraChunk: true })).samples)).toEqual([0.5, -0.5]);
    expect(Array.from(parseWav(wavFile(data, { sizeUnknown: true })).samples)).toEqual([0.5, -0.5]);
  });

  it('refuses what it cannot read with an error that says why', () => {
    expect(() => parseWav(new TextEncoder().encode('not a wav file at all'))).toThrow(AudioError);
    expect(() => parseWav(wavFile(int16([1, 2]), { tag: 85 }))).toThrow(/not supported/);
    expect(() => parseWav(wavFile(new Uint8Array(4), { channels: 0 }))).toThrow(/channels/);
    expect(() => parseWav(wavFile(new Uint8Array(4), { rate: 10 }))).toThrow(/sample rate/);
    expect(() => parseWav(wavFile(new Uint8Array(4), { bits: 12 }))).toThrow(/not supported/);
    const noData = wavFile(new Uint8Array(0)).subarray(0, 12 + 8 + 16);
    expect(() => parseWav(noData)).toThrow(/no audio data/);
  });
});

describe('resample', () => {
  it('keeps the length ratio and the tone: 1 kHz at 48 kHz is still 1 kHz, as loud, at 16 kHz', () => {
    const out = resample(sine(1000, 48000, 1), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(rms(out, 200, 15800)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(999);
    expect(crossings).toBeLessThanOrEqual(1001);
  });

  it('removes what lies above the new Nyquist frequency instead of folding it into the speech band', () => {
    // 10 kHz at 48 kHz would alias to 6 kHz at 16 kHz without a low-pass.
    const out = resample(sine(10000, 48000, 1), 48000, 16000);
    expect(rms(out, 200, 15800)).toBeLessThan(0.02);
  });

  it('also goes up (8 kHz to 16 kHz) and from 44.1 kHz, and leaves a matching rate alone', () => {
    const up = resample(sine(440, 8000, 1), 8000, 16000);
    expect(up.length).toBe(16000);
    expect(rms(up, 200, 15800)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const cd = resample(sine(440, 44100, 1), 44100, 16000);
    expect(cd.length).toBe(16000);
    expect(rms(cd, 200, 15800)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const same = sine(440, 16000, 0.1);
    expect(resample(same, 16000, 16000)).toBe(same);
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it('turns a WAV of any rate and channel count into 16 kHz mono for Whistle', () => {
    const stereo = new Uint8Array(48000 * 2 * 2);
    const view = new DataView(stereo.buffer);
    const tone = sine(500, 48000, 1);
    tone.forEach((v, i) => {
      view.setInt16(i * 4, Math.round(v * 32767), true);
      view.setInt16(i * 4 + 2, Math.round(v * 32767), true);
    });
    const pcm = toWhistleRate(parseWav(wavFile(stereo, { rate: 48000, channels: 2 })));
    expect(pcm.length).toBe(WHISTLE_RATE);
    expect(durationMs(pcm)).toBe(1000);
    expect(peak(pcm)).toBeGreaterThan(0.45);
  });
});

describe('16-bit PCM', () => {
  it('round-trips through floats, clips and drops a trailing odd byte', () => {
    const floats = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const bytes = floatToPcm16(floats);
    expect(bytes.length).toBe(10);
    const back = pcm16ToFloat(bytes);
    floats.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 3));
    expect(Array.from(floatToPcm16(Float32Array.from([2, -2])))).toEqual(Array.from(int16([32767, -32768])));
    expect(pcm16ToFloat(Uint8Array.from([0, 64, 99])).length).toBe(1);
    // A view into a larger buffer (as a request body is) reads from its own offset.
    const big = new Uint8Array(20);
    big.set(int16([16384]), 6);
    expect(pcm16ToFloat(big.subarray(6, 8))[0]).toBe(0.5);
  });

  it('chunks a recording into one-second pieces and measures it', () => {
    const pieces = [...chunked(new Float32Array(40000))];
    expect(pieces.map((p) => p.length)).toEqual([16000, 16000, 8000]);
    expect(durationMs(new Float32Array(8000))).toBe(500);
    expect(peak(Float32Array.from([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
    expect(peak(new Float32Array(0))).toBe(0);
  });
});
