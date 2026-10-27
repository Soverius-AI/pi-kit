import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalHardwareService, localExecutable } from './local-hardware.service';

vi.mock('./detect', () => ({ probeLocalServers: async () => [], defaultProbes: () => [] }));
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local model hardware discovery', () => {
  it('finds actual GGUF files in the chosen directory, rejects unrelated/projector/split files, and revalidates a selected file', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-local-hardware-')));
    scratch.push(dir);
    const models = join(dir, 'chosen folder');
    mkdirSync(models);
    writeFileSync(join(models, 'language.gguf'), Buffer.from('GGUF\u0003\u0000\u0000\u0000model fixture'));
    writeFileSync(join(models, 'not-a-model.gguf'), 'a large enough unrelated text file');
    writeFileSync(join(models, 'mmproj-vision.gguf'), 'GGUFprojector');
    writeFileSync(join(models, 'part-00001-of-00002.gguf'), 'GGUFsplit part');
    symlinkSync(dir, join(models, 'directory-cycle'));
    symlinkSync(join(models, 'language.gguf'), join(models, 'alias.gguf'));
    const service = new LocalHardwareService({ dataDir: dir, localRuntime: { modelDirectories: [models], probeMs: 100 } });
    const facts = await service.detect();
    expect(facts.models.map((model) => model.file)).toEqual(['language.gguf']);
    expect(facts.ramBytes).toBeGreaterThan(0);
    expect(facts.diskFreeBytes).toBeGreaterThan(0);
    expect((await service.model(facts.models[0].id)).path).toBe(join(models, 'language.gguf'));
    writeFileSync(join(models, 'language.gguf'), 'replaced with unrelated contents');
    await expect(service.model(facts.models[0].id)).rejects.toThrow(/missing or invalid/);
    await expect(service.detect(join(dir, 'missing'))).rejects.toThrow(/existing readable model directory/);
  });

  it('does not mistake a directory or a non-executable file for a local tool', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-local-path-')));
    scratch.push(dir);
    mkdirSync(join(dir, 'pk-local-directory-fixture'));
    writeFileSync(join(dir, 'pk-local-file-fixture'), 'not executable', { mode: 0o600 });
    expect(await localExecutable('pk-local-directory-fixture', { PATH: dir })).toBeUndefined();
    if (process.platform !== 'win32') expect(await localExecutable('pk-local-file-fixture', { PATH: dir })).toBeUndefined();
  });
});
