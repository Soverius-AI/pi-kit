import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { emptyTranscript, mergePartial, transcriptText, type TranscribeStreamEvent } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { floatToPcm16 } from './pcm';
import { wavFile } from './wav.testing';
import { TranscribeService } from './transcribe.service';

const tone = (seconds: number, rate = 16000, amplitude = 0.4): Float32Array => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 300 * i) / rate));
const wavOf = (samples: Float32Array, rate = 16000): Uint8Array => wavFile(floatToPcm16(samples), { rate });

describe('TranscribeService with the test engine', () => {
  let dir: string;
  let service: TranscribeService;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-kit-transcribe-'));
    const model = Buffer.from('fixture model '.repeat(20));
    writeFileSync(join(dir, 'model.cact'), model);
    process.env['PI_KIT_TRANSCRIBE_ENGINE'] = 'fake';
    process.env['PI_KIT_WHISTLE_URL'] = pathToFileURL(join(dir, 'model.cact')).href;
    process.env['PI_KIT_WHISTLE_SHA256'] = createHash('sha256').update(model).digest('hex');
    process.env['PI_KIT_WHISTLE_BYTES'] = String(model.length);
    service = new TranscribeService({ dataDir: join(dir, 'data') } as BackendConfig);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    vi.useRealTimers();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  const download = async () => {
    service.startDownload();
    for (let i = 0; i < 100 && service.status().model.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(service.status().model.state).toBe('ready');
  };

  it('asks for the model first: no download without a call, and a recording before it is a 409 that names the button', async () => {
    expect(service.status()).toMatchObject({ engine: 'fake', model: { state: 'missing' }, loaded: false });
    expect(existsSync(join(dir, 'data'))).toBe(false);
    await expect(service.transcribe(wavOf(tone(1)), undefined)).rejects.toThrow(ConflictException);
    await expect(service.transcribe(wavOf(tone(1)), undefined)).rejects.toThrow(/Download Whistle/);
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });

  it('transcribes a WAV of any rate: the text names the 16 kHz length the engine received', async () => {
    await download();
    const result = await service.transcribe(wavOf(tone(2.5, 48000), 48000), undefined);
    expect(result).toMatchObject({ text: 'fixture heard 2.5 seconds of sound.', language: 'en', durationMs: 2500 });
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
    expect(service.status().loaded).toBe(true);
    expect((await service.transcribe(wavOf(tone(1)), 'de')).text).toBe('fixture heard 1.0 seconds of sound in de.');
    expect((await service.transcribe(wavOf(tone(1)), 'de')).language).toBe('de');
  });

  it('answers silence and clicks with no text, without asking the engine', async () => {
    await download();
    expect(await service.transcribe(wavOf(new Float32Array(32000)), undefined)).toMatchObject({ text: '', language: '', durationMs: 2000 });
    expect((await service.transcribe(wavOf(tone(0.05)), undefined)).text).toBe('');
    expect(service.status().loaded).toBe(false);
  });

  it('takes a recording longer than one batch as a stream and gets the same sentence', async () => {
    await download();
    const result = await service.transcribe(wavOf(tone(31)), undefined);
    expect(result.text).toBe('fixture heard 31.0 seconds of sound.');
    expect(result.durationMs).toBe(31000);
  });

  it('streams partials for a recording, then the whole result', async () => {
    await download();
    const events: TranscribeStreamEvent[] = [];
    for await (const event of service.streamRecording(wavOf(tone(3)), 'en')) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['partial', 'partial', 'partial', 'partial', 'done']);
    let so = emptyTranscript();
    for (const event of events) if (event.type === 'partial') so = mergePartial(so, event);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe(transcriptText(so));
    expect(transcriptText(so)).toBe('fixture heard 3.0 seconds of sound in en.');
  });

  it('reports a bad recording as an error event, not a thrown exception', async () => {
    await download();
    const events: TranscribeStreamEvent[] = [];
    for await (const event of service.streamRecording(new TextEncoder().encode('definitely not audio'), undefined)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('transcribes live: chunks of PCM in while the user speaks, partials out, the result at the end', async () => {
    await download();
    const { id } = await service.startLive('en');
    const seen: TranscribeStreamEvent[] = [];
    const off = service.watchLive(id, (e) => seen.push(e));
    const pcm = floatToPcm16(tone(1));
    service.pushLive(id, pcm);
    service.pushLive(id, pcm);
    service.pushLive(id, pcm);
    const result = await service.endLive(id);
    off();
    expect(result.text).toBe('fixture heard 3.0 seconds of sound in en.');
    expect(result.durationMs).toBe(3000);
    expect(seen.filter((e) => e.type === 'partial').length).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)?.type).toBe('done');
    // The session is gone afterwards.
    expect(() => service.pushLive(id, pcm)).toThrow(ConflictException);
    // And the engine is free again.
    expect((await service.transcribe(wavOf(tone(1)), undefined)).text).toContain('1.0 seconds');
  });

  it('a new live session replaces one that was never ended', async () => {
    await download();
    const first = await service.startLive(undefined);
    service.pushLive(first.id, floatToPcm16(tone(1)));
    const second = await service.startLive(undefined);
    expect(() => service.pushLive(first.id, floatToPcm16(tone(1)))).toThrow(ConflictException);
    service.pushLive(second.id, floatToPcm16(tone(2)));
    expect((await service.endLive(second.id)).text).toContain('2.0 seconds');
  });

  it('keeps the engine loaded during an active request and releases it only after that request becomes idle', async () => {
    await download();
    // Advance only disposal timeouts; the live-input inactivity clock is a separate contract.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await service.transcribe(wavOf(tone(1)), undefined);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    const live = await service.startLive('en');
    try {
      service.pushLive(live.id, floatToPcm16(tone(1)));
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(service.status().loaded).toBe(true);
    } finally {
      await service.endLive(live.id);
    }
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.status().loaded).toBe(false);
    expect((await service.transcribe(wavOf(tone(1)), undefined)).text).toContain('1.0 seconds');
  });

  it('removing the model ends everything and starts the consent over', async () => {
    await download();
    await service.transcribe(wavOf(tone(1)), undefined);
    const status = await service.removeModel();
    expect(status.model.state).toBe('missing');
    expect(status.loaded).toBe(false);
    expect(readFileSync(join(dir, 'model.cact')).length).toBeGreaterThan(0);
    await expect(service.transcribe(wavOf(tone(1)), undefined)).rejects.toThrow(ConflictException);
  });
});

// The real model, when a copy is at hand: PI_KIT_WHISTLE_MODEL=/path/to/whistle.cact PI_KIT_WHISTLE_WAV=/path/to/speech.wav
describe.skipIf(!process.env['PI_KIT_WHISTLE_MODEL'] || !process.env['PI_KIT_WHISTLE_WAV'])('Whistle itself (needs the model file and a recording)', () => {
  it('transcribes a recording through the needle WASM engine', async () => {
    const { NeedleEngine } = await import('./needle-engine');
    const { decodeAudio } = await import('./audio-decode');
    const engine = await NeedleEngine.create(process.env['PI_KIT_WHISTLE_MODEL'] as string);
    try {
      const pcm = await decodeAudio(new Uint8Array(readFileSync(process.env['PI_KIT_WHISTLE_WAV'] as string)));
      const result = await engine.transcribe(pcm, { language: 'en' });
      expect(result.text.length).toBeGreaterThan(5);
    } finally {
      await engine.close();
    }
  });
});
