import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import { eventMatches } from '@pi-kit/ui';
import { Chunker, encodeWav16, floatToPcm16Bytes, mixToMono, pushToTalk, releasesCombo, voiceHint } from './voice';

describe('encodeWav16 (the recording as it is sent to the backend)', () => {
  it('writes a canonical 44-byte header and little-endian 16-bit samples', () => {
    const bytes = encodeWav16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2]), 16000);
    const view = new DataView(bytes.buffer);
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 16)).toBe('WAVEfmt ');
    expect(ascii(36, 40)).toBe('data');
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(bytes.length).toBe(44 + 12);
    const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 16384, -16384, 32767, -32768, 32767]);
  });

  it('keeps the sample rate it was given', () => {
    expect(new DataView(encodeWav16(new Float32Array(4), 48000).buffer).getUint32(24, true)).toBe(48000);
    expect(encodeWav16(new Float32Array(0), 16000).length).toBe(44);
  });

  it('floatToPcm16Bytes is the same samples without a header', () => {
    expect(Array.from(floatToPcm16Bytes(Float32Array.from([0.5, -1])))).toEqual([0, 64, 0, 128]);
  });
});

describe('mixToMono and Chunker', () => {
  it('averages channels and leaves a mono signal as it is', () => {
    const mono = Float32Array.from([1, 2]);
    expect(mixToMono([mono])).toBe(mono);
    expect(Array.from(mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5]);
  });

  it('cuts an audio worklet’s 128-sample blocks into whole seconds and flushes the rest', () => {
    const chunker = new Chunker(16000);
    const out: Float32Array[] = [];
    let marker = 0;
    for (let i = 0; i < 300; i++) out.push(...chunker.push(Float32Array.from({ length: 128 }, () => marker++)));
    expect(out.map((c) => c.length)).toEqual([16000, 16000]);
    // Nothing is lost or reordered across the cuts.
    expect(out[0][0]).toBe(0);
    expect(out[0][15999]).toBe(15999);
    expect(out[1][0]).toBe(16000);
    const rest = chunker.flush();
    expect(rest?.length).toBe(300 * 128 - 32000);
    expect(rest?.[0]).toBe(32000);
    expect(chunker.flush()).toBeUndefined();
  });

  it('can return several chunks for one big block', () => {
    const chunker = new Chunker(10);
    expect(chunker.push(new Float32Array(35)).map((c) => c.length)).toEqual([10, 10, 10]);
    expect(chunker.flush()?.length).toBe(5);
  });
});

describe('pushToTalk', () => {
  it('hold: down starts, the release stops, auto-repeat and a second down do nothing', () => {
    expect(pushToTalk('hold', { recording: false }, 'down')).toBe('start');
    expect(pushToTalk('hold', { recording: true }, 'down', true)).toBe('none');
    expect(pushToTalk('hold', { recording: false }, 'down', true)).toBe('none');
    expect(pushToTalk('hold', { recording: true }, 'down')).toBe('none');
    expect(pushToTalk('hold', { recording: true }, 'up')).toBe('stop');
    expect(pushToTalk('hold', { recording: true }, 'blur')).toBe('stop');
    expect(pushToTalk('hold', { recording: false }, 'up')).toBe('none');
  });

  it('toggle: each press flips, releasing does nothing', () => {
    expect(pushToTalk('toggle', { recording: false }, 'down')).toBe('start');
    expect(pushToTalk('toggle', { recording: true }, 'down')).toBe('stop');
    expect(pushToTalk('toggle', { recording: true }, 'down', true)).toBe('none');
    expect(pushToTalk('toggle', { recording: true }, 'up')).toBe('none');
    expect(pushToTalk('toggle', { recording: true }, 'blur')).toBe('none');
  });
});

describe('the push-to-talk key (⌥Space)', () => {
  const down = { key: ' ', code: 'Space', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };

  it('matches on a Mac, where ⌥Space types a no-break space and the key name says nothing', () => {
    expect(eventMatches('alt+space', down)).toBe(true);
    expect(eventMatches('alt+space', { ...down, altKey: false })).toBe(false);
    expect(eventMatches('alt+space', { ...down, shiftKey: true })).toBe(false);
    expect(eventMatches('mod+space', { ...down, altKey: false, metaKey: true })).toBe(true);
  });

  it('ends on the release of Space, or of ⌥ first', () => {
    expect(releasesCombo('alt+space', down, { code: 'Space', key: ' ' })).toBe(true);
    expect(releasesCombo('alt+space', down, { code: 'AltLeft', key: 'Alt' })).toBe(true);
    expect(releasesCombo('alt+space', down, { code: 'KeyA', key: 'a' })).toBe(false);
    expect(releasesCombo('alt+space', down, { code: 'ShiftLeft', key: 'Shift' })).toBe(false);
    expect(releasesCombo('mod+shift+space', down, { code: 'MetaLeft', key: 'Meta' })).toBe(true);
    expect(releasesCombo('mod+shift+space', down, { code: 'ControlLeft', key: 'Control' })).toBe(true);
  });
});

describe('voiceHint', () => {
  it('says what is happening, with the key the user set', () => {
    const base = { key: '⌥Space', mode: 'hold' as const, byKey: true };
    expect(voiceHint(english, 'idle', base)).toBe('');
    expect(voiceHint(english, 'setup', base)).toBe(
      'Voice input runs Whistle on this machine. It needs a one-time 17 MB download.',
    );
    expect(voiceHint(english, 'setup', { ...base, downloadPercent: 42 })).toBe('Downloading Whistle… 42%');
    expect(voiceHint(english, 'setup', { ...base, error: 'The download failed: HTTP 503.' })).toBe(
      'The download failed: HTTP 503.',
    );
    expect(voiceHint(english, 'starting', base)).toBe('Starting the microphone…');
    expect(voiceHint(english, 'listening', base)).toBe('Listening. Release ⌥Space to insert.');
    expect(voiceHint(english, 'listening', { ...base, mode: 'toggle' })).toBe(
      'Listening. Click the microphone to finish.',
    );
    expect(voiceHint(english, 'listening', { ...base, byKey: false })).toBe(
      'Listening. Click the microphone to finish.',
    );
    expect(voiceHint(english, 'listening', { ...base, partial: 'please add a unit' })).toBe('please add a unit');
    expect(voiceHint(english, 'transcribing', base)).toBe('Transcribing…');
    expect(voiceHint(english, 'error', { ...base, error: 'No microphone found' })).toBe('No microphone found');
    expect(voiceHint(english, 'error', base)).toBe('Voice input failed.');
  });
});
