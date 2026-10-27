import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_FILE, DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { LocalLlamaSwapService } from './local-llama-swap.service';
import { LocalLlamaSwapProcessService } from './local-llama-swap-process.service';

vi.mock('./local-llama-swap-discovery', () => ({ discoverLlamaSwapConfigs: vi.fn(async () => []) }));

/** A `llama-swap` on PATH that answers `/v1/models` with the model names of its `-config`, so the service can be driven without the real one. */
const FAKE = `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = args[args.indexOf('-config') + 1];
const listen = args[args.indexOf('-listen') + 1];
const [host, port] = listen.split(':');
const models = [...fs.readFileSync(config, 'utf8').matchAll(/^  ([\\w.-]+):/gm)].map((m) => m[1]);
console.log('fake llama-swap listening on ' + listen);
if (process.env.FAKE_SWAP_EXIT) { console.error('fake llama-swap: cannot bind'); process.exit(3); }
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: models.map((id) => ({ id })) })); }
  else { res.statusCode = 404; res.end(); }
});
server.listen(Number(port), host);
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};
const answers = async (baseUrl: string): Promise<boolean> => { try { return (await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } };

describe('the llama-swap process pi-kit starts', () => {
  let dir: string, db: DatabaseService, meta: MetaRepository, swap: LocalLlamaSwapService, managed: LocalLlamaSwapProcessService, listen: string;
  const secrets = new MemorySecretStore();
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-swap-process-')));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'llama-swap'), FAKE); chmodSync(join(dir, 'bin', 'llama-swap'), 0o755);
    writeFileSync(join(dir, 'config.yaml'), 'models:\n  alpha:\n    cmd: engine --model /tmp/alpha.gguf\n  beta:\n    cmd: engine --model /tmp/beta.gguf\n');
    listen = `127.0.0.1:${await freePort()}`;
    vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', join(dir, 'config.yaml'));
    vi.stubEnv('PI_KIT_LLAMA_SWAP_LISTEN', listen);
    db = await DatabaseService.create({ dataDir: dir }, secrets);
    meta = new MetaRepository(db);
    swap = new LocalLlamaSwapService(meta);
    await swap.readConfigs(true);
    managed = new LocalLlamaSwapProcessService(swap, meta);
  });
  afterEach(async () => {
    await managed.onModuleDestroy();
    vi.unstubAllEnvs();
    db.onApplicationShutdown();
    rmSync(join(dir, DB_FILE), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts llama-swap with the selected config, reports it running, and stops it with the autostart choice', async () => {
    await managed.refresh();
    expect(managed.status()).toMatchObject({ state: 'stopped', canStart: true, configPath: join(dir, 'config.yaml'), listen, baseUrl: `http://${listen}/v1` });
    const states: string[] = [];
    managed.onChange((state) => states.push(state));
    const started = await managed.start({ autostart: true });
    expect(started).toMatchObject({ state: 'running', canStart: false, configPath: join(dir, 'config.yaml') });
    expect(started.pid).toBeGreaterThan(0);
    expect(started.log).toContain(`fake llama-swap listening on ${listen}`);
    expect(await answers(started.baseUrl)).toBe(true);
    expect(managed.autostart()).toBe(true);
    expect(meta.getSetting('local-runtime-autostart')).toEqual({ configPath: join(dir, 'config.yaml'), listen });
    await expect(managed.start({})).rejects.toThrow('already running');
    const stopped = await managed.stop();
    expect(stopped).toMatchObject({ state: 'stopped' });
    expect(await answers(started.baseUrl)).toBe(false);
    expect(managed.autostart()).toBe(false);
    expect(states).toEqual(['running', 'stopped']);
  });

  it('refuses to start over another server on the listener and never touches it', async () => {
    const other = createServer((_req, res) => res.end('{"data":[]}'));
    const [host, port] = listen.split(':');
    await new Promise<void>((resolve) => other.listen(Number(port), host, resolve));
    try {
      await managed.refresh();
      expect(managed.status()).toMatchObject({ state: 'stopped', canStart: false, reason: expect.stringContaining(`already answers on ${listen}`) });
      await expect(managed.start({})).rejects.toThrow(`already answers on ${listen}`);
      expect(await answers(`http://${listen}/v1`)).toBe(true);
    } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });

  it('refuses a config without models or with invalid YAML, and reports a process that exits before answering', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'models: {}');
    await swap.readConfigs(true);
    await managed.refresh();
    expect(managed.status()).toMatchObject({ canStart: false, reason: 'The config has no models yet.' });
    await expect(managed.start({})).rejects.toThrow('no models');
    writeFileSync(join(dir, 'config.yaml'), 'models: [\n');
    await expect(managed.start({})).rejects.toThrow('cannot be used');
    writeFileSync(join(dir, 'config.yaml'), 'models:\n  alpha:\n    cmd: engine\n');
    await swap.readConfigs(true);
    vi.stubEnv('FAKE_SWAP_EXIT', '1');
    await expect(managed.start({})).rejects.toThrow('stopped on its own (3)');
    expect(managed.status()).toMatchObject({ state: 'failed', error: expect.stringContaining('(3)'), log: expect.arrayContaining(['fake llama-swap: cannot bind']) });
  });

  it('starts the saved choice with the app and drops the older private-engine recipe', async () => {
    meta.setSetting('local-runtime-autostart', { model: { id: 'old' }, contextTokens: 4096, autostart: true });
    await managed.startSaved();
    expect(managed.status().state).toBe('stopped');
    expect(meta.getSetting('local-runtime-autostart')).toBeNull();
    meta.setSetting('local-runtime-autostart', { configPath: join(dir, 'config.yaml'), listen });
    await managed.startSaved();
    expect(managed.status()).toMatchObject({ state: 'running' });
    expect(await answers(`http://${listen}/v1`)).toBe(true);
    // The choice on its own: off keeps the process, on records the running process's config and listener.
    managed.setAutostart(false);
    expect(managed.autostart()).toBe(false);
    expect(managed.status().state).toBe('running');
    managed.setAutostart(true);
    expect(meta.getSetting('local-runtime-autostart')).toEqual({ configPath: join(dir, 'config.yaml'), listen });
  });
});
