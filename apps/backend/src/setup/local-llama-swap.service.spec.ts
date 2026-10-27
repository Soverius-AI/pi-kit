import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, chmodSync, statSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { discoverLlamaSwapConfigs } from './local-llama-swap-discovery';
import { LocalLlamaSwapService } from './local-llama-swap.service';

vi.mock('./local-llama-swap-discovery', () => ({ discoverLlamaSwapConfigs: vi.fn(async () => []) }));

const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => home.path }));

describe('shared llama-swap configuration', () => {
  let dir: string, path: string, db: DatabaseService, meta: MetaRepository, service: LocalLlamaSwapService;
  const first = { id: 'a'.repeat(64), file: 'same.gguf', path: "/models/a model's file.gguf", bytes: 100 };
  const second = { ...first, id: 'b'.repeat(64), path: '/models/another.gguf' };
  const content = '# My existing llama-swap config\nhealthCheckTimeout: 90\nmodels:\n  manual: # keep this comment\n    cmd: custom-engine --ctx-size 4096\n    ttl: 600\n';
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-shared-swap-')));
    home.path = dir;
    vi.mocked(discoverLlamaSwapConfigs).mockResolvedValue([]);
    path = join(dir, 'existing.yaml');
    writeFileSync(path, content);
    vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', path);
    vi.stubEnv('LLAMA_SWAP_CONFIG', '');
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, '.config'));
    db = await DatabaseService.create({ dataDir: dir }, new MemorySecretStore());
    meta = new MetaRepository(db);
    service = new LocalLlamaSwapService(meta);
  });
  afterEach(() => { db.onApplicationShutdown(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('reloads only the detected existing process and confirms the selected model is ready via its API', async () => {
    writeFileSync(path, 'apiKeys: [a-private-fixture-key]\nmodels:\n  group/model:\n    cmd: llama-server -c 8192\n');
    const requested: string[] = []; let logs = 'old INFO configuration reloaded\n', loaded = false;
    const server = createServer((request, response) => {
      requested.push(request.url ?? '');
      expect(request.headers.authorization).toBe('Bearer a-private-fixture-key');
      if (request.url === '/api/version') response.end(JSON.stringify({ version: 'v262' }));
      else if (request.url === '/logs') response.end(logs);
      else if (request.url === '/upstream/group/model/') { loaded = true; response.end('ready'); }
      else if (request.url === '/running') response.end(JSON.stringify({ running: loaded ? [{ model: 'group/model', state: 'ready' }] : [] }));
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    vi.mocked(discoverLlamaSwapConfigs).mockResolvedValue([{ path, source: 'Running llama-swap', pid: 987654, baseUrl }]);
    const signalProcess = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => { expect(pid).toBe(987654); expect(signal).toBe('SIGHUP'); logs += 'new INFO configuration reloaded\n'; return true; });
    try {
      const options = await service.modelOptions(path, 'group/model');
      expect(options.reload).toMatchObject({ available: true, baseUrl });
      const progress: string[] = [];
      await service.reloadModel({ path, model: 'group/model', version: options.version }, new AbortController().signal, (detail) => progress.push(detail));
      expect(signalProcess).toHaveBeenCalledOnce(); expect(loaded).toBe(true);
      expect(requested).not.toContain('/api/models/unload');
      expect(progress.at(-1)).toBe('group/model is ready with the saved settings.');
      const previousText = readFileSync(path, 'utf8'); writeFileSync(path, previousText + '# external edit\n');
      await expect(service.reloadModel({ path, model: 'group/model', version: options.version }, new AbortController().signal, () => undefined)).rejects.toThrow('changed since saving');
      expect(signalProcess).toHaveBeenCalledOnce();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('saves per-model controls into the existing YAML while preserving comments, macros and other models', async () => {
    writeFileSync(path, '# Keep header\nmacros:\n  ctx: 4096\nmodels:\n  qwen: # keep model comment\n    cmd: llama-server -m "a model.gguf" -c ${ctx} --port ${PORT} --custom untouched\n    ttl: 60 # keep unload comment\n    aliases: [my-alias]\n  other:\n    cmd: never-change\n');
    const options = await service.modelOptions(path, 'qwen');
    expect(options.values.context).toBe(4096);
    const saved = await service.saveModelOptions({ path, model: 'qwen', version: options.version, values: { context: 32768, ttl: 0 } });
    expect(saved.values).toMatchObject({ context: 32768, ttl: 0 });
    const text = readFileSync(path, 'utf8'), parsed = parse(text);
    expect(text).toContain('# Keep header'); expect(text).toContain('# keep model comment'); expect(text).toContain('# keep unload comment');
    expect(parsed.models.qwen.cmd).toContain('-c 32768'); expect(parsed.models.qwen.cmd).toContain('--custom untouched');
    expect(parsed.models.qwen.cmd).toContain('--port ${PORT}'); expect(parsed.macros.ctx).toBe(4096);
    expect(parsed.models.other.cmd).toBe('never-change'); expect(parsed.models.qwen.aliases).toEqual(['my-alias']);
    await expect(service.saveModelOptions({ path, model: 'qwen', version: options.version, values: { ttl: 30 } })).rejects.toThrow('changed since');
    await expect(service.saveModelOptions({ path, model: 'qwen', version: saved.version, values: { context: -20 } })).rejects.toThrow('invalid');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('saves existing MTP options into the same model command and refuses unverified activation', async () => {
    writeFileSync(path, 'models:\n  mtp:\n    cmd: llama-server --model /missing.gguf --spec-type draft-mtp --spec-draft-n-max 3 --custom keep\n  plain:\n    cmd: llama-server --model /missing.gguf\n');
    const current = await service.modelOptions(path, 'mtp');
    expect(current.mtp?.status).toBe('configured');
    const saved = await service.saveModelOptions({path, model:'mtp', version:current.version, values:{specDraftMax:6, specDraftMin:1, specDraftPMin:0.1}});
    expect(saved.values).toMatchObject({specType:'draft-mtp',specDraftMax:6,specDraftMin:1,specDraftPMin:0.1});
    expect(parse(readFileSync(path,'utf8')).models.mtp.cmd).toContain('--custom keep');
    const plain = await service.modelOptions(path, 'plain'), before = readFileSync(path,'utf8');
    await expect(service.saveModelOptions({path, model:'plain',version:plain.version,values:{specType:'draft-mtp'}})).rejects.toThrow('MTP support could not be verified');
    expect(readFileSync(path,'utf8')).toBe(before);
  });

  it('automatically uses the running service config and remembers it after the service stops', async () => {
    vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', '');
    const active = join(dir, 'custom-service.yaml');
    writeFileSync(active, 'models: {existing: {cmd: never-run}}');
    const common = join(dir, '.config', 'llama-swap', 'config.yaml');
    mkdirSync(join(dir, '.config', 'llama-swap'), { recursive: true });
    writeFileSync(common, 'models: {other: {cmd: never-run}}');
    const linked = join(dir, 'linked-service.yaml'); symlinkSync(active, linked);
    const baseUrl = 'http://127.0.0.1:9090';
    vi.mocked(discoverLlamaSwapConfigs).mockResolvedValue([{ path: linked, source: 'Running llama-swap', baseUrl, pid: 987654 }]);
    const configs = await service.readConfigs(true);
    expect(configs.find((entry) => entry.selected)).toMatchObject({ path: active, source: 'Running llama-swap', baseUrl });
    expect(JSON.stringify(meta.getSetting('local-runtime-discovered-configs'))).not.toContain(baseUrl);
    await service.register(first);
    expect(parse(readFileSync(active, 'utf8')).models[service.modelName(first)]).toBeDefined();
    expect(readFileSync(common, 'utf8')).toBe('models: {other: {cmd: never-run}}');
    vi.mocked(discoverLlamaSwapConfigs).mockResolvedValue([]);
    const reloaded = new LocalLlamaSwapService(meta);
    const stopped = (await reloaded.readConfigs()).find((entry) => entry.selected);
    expect(stopped?.path).toBe(active);
    expect(stopped?.baseUrl).toBeUndefined();
  });

  it('keeps a broken active service config as the target instead of writing another valid config', async () => {
    vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', '');
    const active = join(dir, 'active.yaml'); writeFileSync(active, 'models: [broken]');
    const common = join(dir, '.config', 'llama-swap', 'config.yaml'); mkdirSync(join(dir, '.config', 'llama-swap'), { recursive: true }); writeFileSync(common, 'models: {}');
    vi.mocked(discoverLlamaSwapConfigs).mockResolvedValue([{ path: active, source: 'Running llama-swap' }]);
    const configs = await service.readConfigs(true);
    expect(configs.find((entry) => entry.selected)).toMatchObject({ path: active, error: expect.any(String) });
    await expect(service.register(first)).rejects.toThrow('models entry');
    expect(readFileSync(common, 'utf8')).toBe('models: {}');
  });

  it('edits YAML with content-version conflict protection and preserves file permissions', async () => {
    chmodSync(path, 0o640);
    const loaded = await service.configFile(path);
    const edited = loaded.text + '\nttl: 120\n';
    const saved = await service.saveConfigFile({ path, text: edited, version: loaded.version });
    expect(saved.text).toBe(edited);
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(saved.version).not.toBe(loaded.version);
    await expect(service.saveConfigFile({ path, text: loaded.text, version: loaded.version })).rejects.toThrow('changed since');
    expect(readFileSync(path, 'utf8')).toBe(edited);
    await expect(service.saveConfigFile({ path, text: 'models: [invalid]', version: saved.version })).rejects.toThrow('models entry');
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });

  it('can repair invalid detected YAML but cannot edit an unrelated undiscovered file', async () => {
    writeFileSync(path, 'models: {broken');
    const loaded = await service.configFile(path);
    expect(loaded.text).toBe('models: {broken');
    await service.saveConfigFile({ path, text: '# repaired\nmodels: {}\n', version: loaded.version });
    expect(readFileSync(path, 'utf8')).toBe('# repaired\nmodels: {}\n');
    const unrelated = join(dir, 'unrelated.yaml'); writeFileSync(unrelated, 'models: {}');
    await expect(service.configFile(unrelated)).rejects.toThrow('detected llama-swap');
  });

  it('adds downloads to the existing file while preserving comments, engine options and permissions', async () => {
    chmodSync(path, 0o640);
    await service.register(first);
    await service.register(second);
    const text = readFileSync(path, 'utf8'), config = parse(text);
    expect(text).toContain('# My existing llama-swap config');
    expect(text).toContain('# keep this comment');
    expect(config.healthCheckTimeout).toBe(90);
    expect(config.models.manual).toEqual({ cmd: 'custom-engine --ctx-size 4096', ttl: 600 });
    expect(config.models[service.modelName(first)].cmd).toContain('${PORT}');
    expect(config.models[service.modelName(first)].cmd).not.toContain('--ctx-size');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(service.status().engine.configPath).toBe(path);
    expect(service.status().engine.modelIds).toEqual([first.id, second.id]);
    expect(existsSync(join(dir, 'local-runtime'))).toBe(false);
    await service.unregister(first.id);
    const removed = parse(readFileSync(path, 'utf8'));
    expect(removed.models[service.modelName(first)]).toBeUndefined();
    expect(removed.models.manual.cmd).toBe('custom-engine --ctx-size 4096');
    expect(removed.models[service.modelName(second)]).toBeDefined();
  });

  it('keeps collisions and customized entries intact and reuses the same registration after a restart', async () => {
    const name = service.modelName(first);
    writeFileSync(path, `models:\n  ${name}:\n    cmd: existing-unrelated-command\n`);
    await service.register(first);
    await service.register(first);
    const config = parse(readFileSync(path, 'utf8'));
    expect(config.models[name].cmd).toBe('existing-unrelated-command');
    expect(Object.keys(config.models)).toHaveLength(2);
    expect(config.models[`${name}-2`].cmd).toContain('--model');
    const reloaded = new LocalLlamaSwapService(meta);
    await reloaded.register(first);
    expect(Object.keys(parse(readFileSync(path, 'utf8')).models)).toHaveLength(2);
    await reloaded.unregister(first.id);
    expect(parse(readFileSync(path, 'utf8')).models).toEqual({ [name]: { cmd: 'existing-unrelated-command' } });
  });

  it('preserves an entry repurposed by the user and gives the downloaded file a new registration', async () => {
    await service.register(first);
    const name = service.modelName(first);
    writeFileSync(path, `models:\n  ${name}:\n    cmd: user-repurposed-entry\n`);
    await service.register(first);
    const changed = parse(readFileSync(path, 'utf8'));
    expect(changed.models[name].cmd).toBe('user-repurposed-entry');
    expect(changed.models[`${name}-2`].cmd).toContain('--model');
    await service.unregister(first.id);
    expect(parse(readFileSync(path, 'utf8')).models).toEqual({ [name]: { cmd: 'user-repurposed-entry' } });
  });

  it('adds already downloaded files when an existing config is selected without starting a process or rewriting the old config', async () => {
    const file = join(dir, 'downloaded.gguf'); writeFileSync(file, 'GGUF fixture');
    const downloaded = { ...first, path: file };
    meta.setSetting('local-runtime-models', [downloaded, { ...second, path: join(dir, 'missing.gguf') }]);
    const legacy = join(dir, 'local-runtime', 'llama-swap.yaml'); mkdirSync(join(dir, 'local-runtime'));
    writeFileSync(legacy, 'models: {legacy: {cmd: old-private-engine}}');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await service.selectConfig(path);
    const config = parse(readFileSync(path, 'utf8'));
    expect(config.models[service.modelName(downloaded)].cmd).toContain(file);
    expect(config.models[service.modelName(second)]).toBeUndefined();
    expect(config.models.manual.cmd).toBe('custom-engine --ctx-size 4096');
    expect(readFileSync(legacy, 'utf8')).toBe('models: {legacy: {cmd: old-private-engine}}');
    expect(fetch).not.toHaveBeenCalled();
    const reloaded = new LocalLlamaSwapService(meta);
    const configs = await reloaded.readConfigs();
    expect(configs.find((entry) => entry.path === path)).toMatchObject({ selected: true, models: ['manual', service.modelName(downloaded)] });
    expect(configs.some((entry) => entry.path === legacy)).toBe(false);
  });

  it('honors YAML model removals when another model is downloaded later', async () => {
    const a = join(dir, 'a.gguf'), b = join(dir, 'b.gguf'); writeFileSync(a, 'GGUF'); writeFileSync(b, 'GGUF');
    const existing = { ...first, path: a }, next = { ...second, path: b };
    meta.setSetting('local-runtime-models', [existing]);
    await service.register(existing);
    const loaded = await service.configFile(path);
    await service.saveConfigFile({ path, text: 'models: {}', version: loaded.version });
    await service.register(next);
    const config = parse(readFileSync(path, 'utf8'));
    expect(config.models[service.modelName(existing)]).toBeUndefined();
    expect(config.models[service.modelName(next)]).toBeDefined();
  });

  it('reads offline edits and keeps symlinks intact when appending models', async () => {
    const linked = join(dir, 'linked.yaml'); symlinkSync(path, linked);
    await service.selectConfig(linked);
    await service.register(first);
    expect(readlinkSync(linked)).toBe(path);
    expect((await service.readConfigs()).filter((config) => config.path === path)).toHaveLength(1);
    writeFileSync(path, 'models: {edited-offline: {cmd: never-run}}');
    expect((await service.readConfigs()).find((config) => config.path === path)?.models).toEqual(['edited-offline']);
    expect(service.status().engine.modelIds).toEqual([]);
    rmSync(path);
    expect((await service.readConfigs()).find((config) => config.path === linked)?.error).toBe('This config file no longer exists.');
    await expect(service.register(second)).rejects.toThrow('no longer exists');
  });

  it('requires a target when multiple configs are discovered and uses a standard shared location only for first-time setup', async () => {
    vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', '');
    const defaultPath = join(dir, '.config', 'llama-swap', 'config.yaml');
    await expect(service.register(first)).rejects.toThrow('Choose an existing');
    expect(existsSync(defaultPath)).toBe(false);
    await service.refreshTools(true);
    await service.register(first);
    expect(service.status().engine.configPath).toBe(defaultPath);
    expect(existsSync(join(dir, 'local-runtime'))).toBe(false);
    mkdirSync(join(dir, 'llama-swap'));
    writeFileSync(join(dir, 'llama-swap', 'config.yaml'), 'models: {}');
    await expect(service.prepareTarget()).rejects.toThrow('More than one config');
    await service.selectConfig(defaultPath);
    await service.register(second);
    expect(parse(readFileSync(defaultPath, 'utf8')).models[service.modelName(second)]).toBeDefined();
  });

  it('rejects malformed and oversized configs without overwriting the file or changing the selected target', async () => {
    await service.selectConfig(path);
    const broken = join(dir, 'broken.yaml');
    for (const text of ['models: [invalid]', 'models: {broken', 'x'.repeat(2_000_001)]) {
      writeFileSync(broken, text);
      await expect(service.selectConfig(broken)).rejects.toThrow();
      expect(service.externalConfigPath()).toBe(path);
      expect(readFileSync(broken, 'utf8')).toBe(text);
    }
    writeFileSync(path, 'models: [private-secret]');
    const bad = (await service.readConfigs()).find((config) => config.path === path);
    expect(bad?.error).toContain('models entry must be a YAML object');
    expect(bad?.error).not.toContain('private-secret');
    await expect(service.register(first)).rejects.toThrow('models entry');
    expect(readFileSync(path, 'utf8')).toBe('models: [private-secret]');
  });
});
