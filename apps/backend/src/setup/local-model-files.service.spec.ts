import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { LocalModelCandidate } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalHardwareService } from './local-hardware.service';
import { LocalModelCatalogService } from './local-model-catalog.service';
import { LocalModelFilesService } from './local-model-files.service';

const bytes = Buffer.from('GGUF\u0003\u0000\u0000\u0000a small deterministic model download fixture');
const model: LocalModelCandidate = {
  id: 'c'.repeat(64), repository: 'Qwen/Fixture-GGUF', revision: 'a'.repeat(40), file: 'fixture-Q4_K_M.gguf', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), license: 'apache-2.0', source: 'https://huggingface.co/Qwen/Fixture-GGUF', downloads: 0,
  estimate: { contextTokens: 8192, memoryBytes: 1, fitsMemory: true, fitsDisk: true, explanation: 'not used by the downloader' },
};

describe('managed local-model files', () => {
  let dir: string, hardware: LocalHardwareService, service: LocalModelFilesService;
  const fetchModel = vi.fn();
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-local-download-')));
    hardware = new LocalHardwareService({ dataDir: dir, localRuntime: { modelDirectories: [] } });
    service = new LocalModelFilesService(hardware, new LocalModelCatalogService(hardware), {});
    fetchModel.mockReset();
    vi.stubGlobal('fetch', fetchModel);
  });
  afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
  const names = () => readdirSync(hardware.modelsDirectory());

  it('rejects a checksum mismatch without publishing a model, retries cleanly, and verifies later file integrity', async () => {
    fetchModel.mockResolvedValueOnce(new Response(Buffer.from(bytes).fill(65, 8)));
    await expect(service.download(model, new AbortController().signal, () => undefined)).rejects.toThrow(/checksum did not match/);
    expect(names()).toEqual([]);
    fetchModel.mockResolvedValueOnce(new Response(bytes));
    const ready = await service.download(model, new AbortController().signal, () => undefined);
    expect(readFileSync(ready.path)).toEqual(bytes);
    expect(ready).toMatchObject({ source: model.source, sha256: model.sha256 });
    // A previous process died mid-download; retry clears only that target's owned partials and preserves unrelated files.
    const interrupted = `${ready.path}.${randomUUID()}.part`;
    writeFileSync(interrupted, 'partial'); writeFileSync(`${interrupted}.json`, 'metadata');
    writeFileSync(join(hardware.modelsDirectory(), 'unrelated.part'), 'keep');
    expect((await service.verifiedModel(ready.id, new AbortController().signal)).path).toBe(ready.path);
    writeFileSync(ready.path, Buffer.from(bytes).fill(66, 8));
    await expect(service.verifiedModel(ready.id, new AbortController().signal)).rejects.toThrow(/checksum no longer matches/);
    fetchModel.mockResolvedValueOnce(new Response(bytes));
    const repaired = await service.download(model, new AbortController().signal, () => undefined);
    expect(readFileSync(repaired.path)).toEqual(bytes);
    expect(names().some((name) => name.includes('.corrupt-'))).toBe(true);
    expect(names().filter((name) => name.includes('.part'))).toEqual(['unrelated.part']);
    expect(names()).toContain(basename(ready.path));
  });

  it('cancels a live stream and removes partial files before allowing a retry', async () => {
    const abort = new AbortController();
    let cancelled = false;
    fetchModel.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); }, cancel() { cancelled = true; } })));
    await expect(service.download(model, abort.signal, () => abort.abort())).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(names()).toEqual([]);
    fetchModel.mockResolvedValueOnce(new Response(bytes));
    const ready = await service.download(model, new AbortController().signal, () => undefined);
    expect(readFileSync(ready.path)).toEqual(bytes);
  });

  it('lists real orphaned bytes, cleans only owned partials and separately removes corrupt backups', async () => {
    const folder = hardware.modelsDirectory();
    mkdirSync(folder);
    const partial = `model.gguf.${randomUUID()}.part`;
    writeFileSync(join(folder, partial), 'partial-data');
    writeFileSync(join(folder, `${partial}.json`), 'metadata');
    writeFileSync(join(folder, 'model.gguf.corrupt-1234'), 'bad-copy');
    writeFileSync(join(folder, 'unrelated.part'), 'keep');
    const target = join(dir, 'external-file'); writeFileSync(target, 'never delete');
    const link = join(folder, `linked.gguf.${randomUUID()}.part`); symlinkSync(target, link);
    const inventory = await service.storage();
    expect(inventory.files.map((file) => file.kind).sort()).toEqual(['corrupt', 'partial', 'partial']);
    const cleanup = await service.cleanup();
    expect(cleanup.removedBytes).toBe(Buffer.byteLength('partial-datametadata'));
    expect(cleanup.storage.files.map((file) => file.kind)).toEqual(['corrupt']);
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('never delete');
    const removed = await service.removeFile(cleanup.storage.files[0].id);
    expect(removed.removedBytes).toBe(8);
    expect(removed.storage.files).toEqual([]);
    await expect(service.removeFile('../../external-file')).rejects.toThrow();
    expect(names()).toContain('unrelated.part');
  });

  it('deletes the selected installed model and its managed metadata without touching another file', async () => {
    fetchModel.mockResolvedValueOnce(new Response(bytes));
    const ready = await service.download(model, new AbortController().signal, () => undefined);
    writeFileSync(join(hardware.modelsDirectory(), 'other.gguf'), bytes);
    const result = await service.removeModel(ready.id);
    expect(result.removedBytes).toBe(bytes.length);
    expect(existsSync(ready.path)).toBe(false);
    expect(existsSync(`${ready.path}.json`)).toBe(false);
    expect(names()).toEqual(['other.gguf']);
    await expect(service.removeModel(ready.id)).rejects.toThrow(/missing|invalid/);
  });

  it('refuses insufficient disk space before fetching any model data', async () => {
    vi.spyOn(hardware, 'diskFree').mockResolvedValueOnce(0);
    await expect(service.download(model, new AbortController().signal, () => undefined)).rejects.toThrow(/Not enough free disk/);
    expect(fetchModel).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });
});
