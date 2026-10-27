import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_FILE, DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { LocalHardwareService } from './local-hardware.service';
import { LocalLlamaSwapService } from './local-llama-swap.service';
import { LocalLlamaSwapProcessService } from './local-llama-swap-process.service';

vi.mock('./local-llama-swap-discovery', () => ({ discoverLlamaSwapConfigs: vi.fn(async () => []) }));
import { LocalModelCatalogService } from './local-model-catalog.service';
import { LocalModelFilesService } from './local-model-files.service';
import { LocalRuntimeService } from './local-runtime.service';

/** Orchestration owns locking/recovery; downloader tests separately prove streaming and file integrity. */
describe('backend-owned local setup jobs', () => {
  let dir: string, db: DatabaseService, meta: MetaRepository, runtime: LocalRuntimeService;
  let hardware: LocalHardwareService, catalog: LocalModelCatalogService, files: LocalModelFilesService, managed: LocalLlamaSwapService;
  const secrets = new MemorySecretStore();
  const candidate = { id: 'choice', repository: 'Qwen/Fixture', revision: 'a'.repeat(40), file: 'private-model.gguf', bytes: 64, sha256: 'b'.repeat(64), license: 'apache-2.0', source: 'https://huggingface.co/Qwen/Fixture', downloads: 0, estimate: { contextTokens: 8192, memoryBytes: 64, fitsMemory: true, fitsDisk: true, explanation: 'Fixture' } };
  const model = { id: 'model-fixture', path: '/local/private-model.gguf', file: 'private-model.gguf', bytes: 64 };
  const create = () => {
    hardware = new LocalHardwareService({ dataDir: dir });
    catalog = new LocalModelCatalogService(hardware);
    files = new LocalModelFilesService(hardware, catalog, {});
    managed = new LocalLlamaSwapService(meta);
    return new LocalRuntimeService(hardware, catalog, files, managed, meta, {}, new LocalLlamaSwapProcessService(managed, meta));
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-runtime-job-'));
    vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', join(dir, 'shared.yaml'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline fixture'));
    writeFileSync(join(dir, 'shared.yaml'), 'models: {}');
    db = await DatabaseService.create({ dataDir: dir }, secrets);
    meta = new MetaRepository(db);
    runtime = create();
  });
  afterEach(async () => { await runtime.onModuleDestroy(); db.onApplicationShutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it('discovers existing servers and reads the shared config without creating an engine', async () => {
    const server = { kind: 'llama-swap' as const, name: 'Existing llama-swap', baseUrl: 'http://127.0.0.1:8080/v1', models: ['manual'] };
    const facts = { platform: 'darwin', arch: 'arm64', cpu: 'Fixture', cores: 8, ramBytes: 16, freeRamBytes: 8, diskFreeBytes: 20, acceleration: { kind: 'cpu' as const, name: 'CPU', sharedMemory: false }, models: [], servers: [server], tools: [], installer: { supported: false, reason: 'Fixture', sources: [] } };
    vi.spyOn(hardware, 'detect').mockResolvedValue(facts);
    const detected = await runtime.detect('/models');
    expect(detected.servers).toEqual([server]);
    expect(detected.llamaSwapConfigPath).toContain('shared.yaml');
    expect(hardware.detect).toHaveBeenCalledWith('/models', [expect.objectContaining({ kind: 'llama-swap' })]);
    expect(runtime.status().job).toBeUndefined();
    expect(runtime.status().server).toBeUndefined();
  });

  it('runs the documented installer commands, exposes a failed install, and retries without reinstalling an existing tool', async () => {
    const bin = join(dir, 'bin'), calls = join(dir, 'installer-calls.jsonl'), retryMarker = join(dir, 'retry');
    mkdirSync(bin);
    const brew = join(bin, 'brew'), swap = join(bin, 'llama-swap');
    writeFileSync(brew, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='install'){if(!fs.existsSync(${JSON.stringify(retryMarker)})){console.error('fixture: install interrupted');process.exit(9)}fs.writeFileSync(${JSON.stringify(swap)},'#!/bin/sh\\necho version: fixture\\n',{mode:0o755})}\n`);
    chmodSync(brew, 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    vi.spyOn(hardware, 'detect').mockResolvedValue({ platform: 'darwin', arch: 'arm64', cpu: 'Fixture', cores: 8, ramBytes: 16 * 1024 ** 3, freeRamBytes: 8 * 1024 ** 3, diskFreeBytes: 20 * 1024 ** 3, acceleration: { kind: 'cpu', name: 'CPU', sharedMemory: false }, models: [], servers: [], tools: [{ id: 'llama-server', path: '/installed/llama-server' }, { id: 'brew', path: brew }], installer: { supported: true, reason: 'Fixture Homebrew process', sources: [] } });
    runtime.install(['llama.cpp', 'llama-swap']);
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('failed'));
    expect(runtime.status().job?.error).toContain('(9)');
    expect(runtime.status().job?.logs).toContain('fixture: install interrupted');
    writeFileSync(retryMarker, 'retry');
    runtime.install(['llama.cpp', 'llama-swap']);
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('complete'));
    expect(readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      ['tap', 'mostlygeek/llama-swap'], ['install', 'mostlygeek/llama-swap/llama-swap'],
      ['tap', 'mostlygeek/llama-swap'], ['install', 'mostlygeek/llama-swap/llama-swap'],
    ]);
    expect(readFileSync(swap, 'utf8')).toContain('version: fixture');
  });

  it('keeps cancellation locked until cleanup ends, retries, and recovers terminal progress from encrypted storage', async () => {
    vi.spyOn(catalog, 'selection').mockReturnValue(candidate);
    let clean: (() => void) | undefined, aborted = false;
    vi.spyOn(files, 'download').mockImplementationOnce((_selected, signal, progress) => {
      progress(12, 64);
      return new Promise((_resolve, reject) => {
        clean = () => reject(new Error('cancelled after cleanup'));
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      });
    }).mockResolvedValueOnce(model);
    const job = runtime.download('choice');
    await vi.waitFor(() => expect(runtime.status().job?.receivedBytes).toBe(12));
    expect(runtime.cancel().job?.state).toBe('cancelling');
    expect(aborted).toBe(true);
    expect(() => runtime.download('choice')).toThrow(ConflictException);
    clean?.();
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('cancelled'));
    runtime.download('choice');
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('complete'));
    expect(runtime.status().job).toMatchObject({ kind: 'download', model });
    expect(runtime.status().job?.id).not.toBe(job.id);
    await runtime.onModuleDestroy(); db.onApplicationShutdown();
    expect(readFileSync(join(dir, DB_FILE)).includes(Buffer.from('private-model'))).toBe(false);
    db = await DatabaseService.create({ dataDir: dir }, secrets); meta = new MetaRepository(db); runtime = create();
    runtime.onApplicationBootstrap();
    expect(runtime.status().job).toMatchObject({ state: 'complete', model });
  });

  it('persists the exact download identity and retries it after a restart without catalogue state', async () => {
    vi.spyOn(catalog, 'selection').mockReturnValue(candidate);
    vi.spyOn(files, 'download').mockRejectedValueOnce(new Error('network disconnected'));
    runtime.download(candidate.id);
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('failed'));
    expect(runtime.status().job?.action).toEqual({ kind: 'download', candidate });
    await runtime.onModuleDestroy();
    runtime = create();
    const choose = vi.spyOn(catalog, 'selection').mockImplementation(() => { throw new Error('catalogue was not searched'); });
    const download = vi.spyOn(files, 'download').mockResolvedValue(model);
    runtime.onApplicationBootstrap();
    runtime.retry();
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('complete'));
    expect(choose).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(candidate, expect.any(AbortSignal), expect.any(Function));
    expect(runtime.status().engine?.modelIds).toContain(model.id);
    runtime.dismiss();
    expect(runtime.status().job).toBeUndefined();
    runtime = create();
    expect(runtime.status().job).toBeUndefined();
  });

  it('disables legacy private-engine autostart without replacing a saved download or launching a process', async () => {
    meta.setSetting('local-runtime-job', { id: 'saved-download', kind: 'download', state: 'cancelled', detail: 'Cancelled', startedAt: 1, logs: [], action: { kind: 'download', candidate } });
    meta.setSetting('local-runtime-autostart', { model, autostart: true });
    runtime = create();
    runtime.onApplicationBootstrap();
    expect(runtime.status().job?.id).toBe('saved-download');
    await vi.waitFor(() => expect(meta.getSetting('local-runtime-autostart')).toBeNull());
    expect(runtime.status().autostart).toBe(false);
    expect(runtime.status().server).toBeUndefined();
    expect(runtime.status().managed?.state).toBe('stopped');
  });

  it('rejects cleanup and model removal while a download still owns its files', async () => {
    vi.spyOn(catalog, 'selection').mockReturnValue(candidate);
    let finish!: () => void;
    vi.spyOn(files, 'download').mockImplementation(() => new Promise((resolve) => { finish = () => resolve(model); }));
    runtime.download(candidate.id);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(runtime.cleanup()).rejects.toThrow(ConflictException);
    await expect(runtime.removeModel(model.id)).rejects.toThrow(ConflictException);
    expect(() => runtime.dismiss()).toThrow(ConflictException);
    finish();
    await vi.waitFor(() => expect(runtime.status().job?.state).toBe('complete'));
  });

  it('marks interrupted persisted work failed on restart without silently restarting a download', async () => {
    meta.setSetting('local-runtime-job', { id: 'interrupted', kind: 'download', state: 'running', startedAt: 10, detail: 'Downloading', logs: [], receivedBytes: 12, totalBytes: 64 });
    runtime = create();
    const download = vi.spyOn(files, 'download');
    runtime.onApplicationBootstrap();
    expect(runtime.status().job).toMatchObject({ id: 'interrupted', state: 'failed', detail: expect.stringContaining('interrupted'), error: expect.stringContaining('stopped') });
    expect(download).not.toHaveBeenCalled();
    expect(meta.getSetting('local-runtime-job')).toMatchObject({ state: 'failed' });
  });

  it('rejects config changes while a download is active and leaves external services alone on shutdown', async () => {
    vi.spyOn(catalog, 'selection').mockReturnValue(candidate);
    vi.spyOn(files, 'download').mockImplementation((_selected, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
    runtime.download('choice');
    await vi.waitFor(() => expect(files.download).toHaveBeenCalled());
    await expect(runtime.readConfig(join(dir, 'shared.yaml'))).rejects.toThrow(ConflictException);
    await runtime.onModuleDestroy();
    expect(runtime.status().job?.state).toBe('cancelled');
    expect(runtime.status().server).toBeUndefined();
  });
});
