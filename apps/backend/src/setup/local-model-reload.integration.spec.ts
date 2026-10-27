import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { reloadExistingModel } from './local-model-reload';

/** Opt-in: a disposable native daemon and tiny HTTP engine; never touches the user's running instance. */
describe('native existing-instance reload', () => {
  it.skipIf(!process.env['PI_KIT_LLAMA_SWAP_TEST_BIN'])('applies a changed config and reports the reloaded engine ready without replacing the daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pk-swap-reload-'));
    const port = async (): Promise<number> => {
      const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!address || typeof address === 'string') throw new Error('No fixture port'); return address.port;
    };
    const listener = await port(), enginePort = await port(), baseUrl = `http://127.0.0.1:${listener}`;
    const engine = join(dir, 'engine.mjs'), path = join(dir, 'config.yaml');
    await writeFile(engine, `import { createServer } from 'node:http'; const i=process.argv.indexOf('--port'); createServer((q,r)=>r.end('ready')).listen(Number(process.argv[i+1]),'127.0.0.1');`);
    const config = (context: number): string => `logLevel: info\nlogToStdout: proxy\nhealthCheckTimeout: 5\nstartPort: ${enginePort}\nstore:\n  path: ${JSON.stringify(join(dir, 'store.sqlite'))}\nmodels:\n  test-model:\n    cmd: ${JSON.stringify(`'${process.execPath}' '${engine}' --port \${PORT} --ctx-size ${context}`)}\n`;
    await writeFile(path, config(4096));
    const child = spawn(process.env['PI_KIT_LLAMA_SWAP_TEST_BIN'] ?? '', ['-config', path, '-listen', `127.0.0.1:${listener}`], { cwd: dir, env: { ...process.env, HOME: dir }, stdio: 'ignore', detached: true });
    const pid = child.pid;
    try {
      const until = Date.now() + 15_000; let up = false;
      while (Date.now() < until && !up) { up = await fetch(`${baseUrl}/api/version`).then((response) => response.ok).catch(() => false); if (!up) await pause(100); }
      expect(up).toBe(true); expect(pid).toBeTypeOf('number');
      await (await fetch(`${baseUrl}/upstream/test-model/`, { signal: AbortSignal.timeout(10_000) })).text();
      await writeFile(path, config(8192));
      const progress: string[] = [];
      await reloadExistingModel({ baseUrl, model: 'test-model', headers: {}, timeoutMs: 10_000, watching: false, signal: new AbortController().signal, progress: (detail) => progress.push(detail), verify: async () => { expect(child.exitCode).toBeNull(); }, signalReload: async () => { if (!pid) throw new Error('No fixture PID'); process.kill(pid, 'SIGHUP'); } });
      const running = await (await fetch(`${baseUrl}/running`)).json() as { running: { model: string; cmd: string; state: string }[] };
      expect(running.running.find((model) => model.model === 'test-model')).toMatchObject({ state: 'ready', cmd: expect.stringContaining('--ctx-size 8192') });
      expect(child.pid).toBe(pid); expect(child.exitCode).toBeNull();
      expect(progress.at(-1)).toBe('test-model is ready with the saved settings.');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGTERM');
        await Promise.race([exited, pause(5000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 35_000);
});
