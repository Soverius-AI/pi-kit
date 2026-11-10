import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, SandboxError, type SandboxClient } from '../dist/core.js';
import { PiSandbox } from '../dist/pi.js';

const enabled = process.env.PI_SANDBOX_SMOKE === '1';
const experimentalWindowsAccepted = process.env.PI_SANDBOX_WINDOWS_ACCEPT === '1';
const quiet = { onData: () => undefined };

test(
  'real SRT: fs, sensitive reads, host escape, env, FIFO, two owners, cancellation and crash',
  { skip: !enabled, timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-srt-test-')));
    let a: SandboxClient | undefined, b: SandboxClient | undefined;
    try {
      await writeFile(path.join(root, '.env'), 'private-token');
      await writeFile(path.join(root, 'protected'), 'private-host-state');
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested', '.env.local'), 'nested-secret');
      a = await Sandbox.create({
        cwd: root,
        protectedPaths: [path.join(root, 'protected')],
        experimentalWindowsAccepted,
      });
      b = await Sandbox.create({ cwd: root, experimentalWindowsAccepted });
      assert.equal(a.state, 'active');
      await a.request('writeFile', [path.join(root, 'binary'), Buffer.from([0, 255, 42])]);
      assert.deepEqual(await a.request('readFile', [path.join(root, 'binary')]), Buffer.from([0, 255, 42]));
      for (const name of ['.env', 'protected', 'nested/.env.local'])
        await assert.rejects(a.request('readFile', [path.join(root, name)]));
      await assert.rejects(a.request('writeFile', [path.join(root, 'protected'), 'overwrite']));
      await assert.rejects(a.request('writeFile', [path.join(root, '.env'), 'overwrite']));
      const outside = path.join(path.dirname(root), `escape-${path.basename(root)}`);
      await assert.rejects(a.request('writeFile', [outside, 'unsafe']));
      await assert.rejects(readFile(outside));
      await assert.rejects(a.request('eval', ['process.exit()']), { code: 'UNSUPPORTED_OPERATION' });
      if (process.platform !== 'win32') {
        let text = '';
        await a.exec('printf "%s:%s" "${BASH_ENV-unset}" "${API_KEY-unset}"', root, {
          onData: (chunk) => (text += chunk),
          env: { BASH_ENV: '/etc/profile', API_KEY: 'secret' },
        });
        assert.equal(text, 'unset:unset');
        assert.equal((await a.exec('mkfifo pipe', root, quiet)).exitCode, 0);
        const started = Date.now();
        await assert.rejects(a.request('readFile', [path.join(root, 'pipe')]), { code: 'NOT_REGULAR_FILE' });
        assert.ok(Date.now() - started < 2000);
        const controller = new AbortController();
        const cancelled = a.exec('sleep 20', root, { ...quiet, signal: controller.signal });
        const sibling = a.exec('sleep 0.3; printf sibling', root, quiet);
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(cancelled, { code: 'ABORT_ERR' });
        await assert.rejects(a.exec('sleep 20', root, { ...quiet, timeout: 0.05 }), { code: 'TIMEOUT' });
        assert.equal((await sibling).exitCode, 0);
        let net = '';
        await a.exec(
          `"${process.execPath}" -e 'require("http").get("http://example.com",r=>{console.log(r.statusCode);r.resume()}).on("error",e=>console.log(e.code))'`,
          root,
          { timeout: 5, onData: (chunk) => (net += chunk) },
        );
        assert.ok(!net.includes('200'));
        await assert.rejects(a.exec('kill -KILL "$PPID"', root, quiet));
        assert.equal(a.state, 'unavailable');
        assert.ok(a.reason);
        await assert.rejects(a.request('readFile', [path.join(root, 'binary')]));
        await assert.rejects(a.close(), { code: 'TEARDOWN_UNCONFIRMED' });
      } else await a.close();
      assert.equal(a.state, 'closed');
      await assert.rejects(a.request('readFile', [path.join(root, 'binary')]));
      assert.equal(b.state, 'active');
      assert.deepEqual(await b.request('readFile', [path.join(root, 'binary')]), Buffer.from([0, 255, 42]));
      await b.close();
      assert.equal(b.state, 'closed');
    } finally {
      await Promise.allSettled([a?.close(), b?.close()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'real SRT: pi’s grep runs in the worker and cannot read outside the workspace',
  { skip: !enabled || process.platform === 'win32', timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-srt-grep-')));
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-srt-outside-')));
    let client: SandboxClient | undefined;
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(path.join(root, 'src', 'a.ts'), 'const marker = 1;\n');
      await writeFile(path.join(outside, 'secret.txt'), 'marker in a file the sandbox may not read\n');
      client = await Sandbox.create({ cwd: root });
      const sdk = await import('@earendil-works/pi-coding-agent');
      const grep = PiSandbox.toolDefinitions(sdk, { client, cwd: root, assertCurrent: () => undefined }).find(
        (tool) => tool.name === 'grep',
      );
      assert.ok(grep);
      const found = await grep.execute('1', { pattern: 'marker' }, undefined, undefined, { cwd: root } as never);
      assert.deepEqual(found.content, [{ type: 'text', text: 'src/a.ts:1: const marker = 1;' }]);
      await assert.rejects(
        grep.execute('2', { pattern: 'marker', path: outside }, undefined, undefined, { cwd: root } as never),
      );
    } finally {
      await client?.close();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

test(
  'real SRT: close acknowledges before removing a large scope temp',
  { skip: !enabled || process.platform === 'win32', timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-srt-temp-')));
    try {
      const client = await Sandbox.create({ cwd: root });
      let home = '';
      const result = await client.exec(
        'mkdir -p "$HOME/cache" && cd "$HOME/cache" && for i in $(seq 1 20000); do : > "f$i"; done; printf "%s" "$HOME"',
        root,
        { timeout: 50, onData: (chunk) => (home += chunk) },
      );
      assert.equal(result.exitCode, 0);
      assert.equal((await readdir(path.join(home, 'cache'))).length, 20000);
      const started = Date.now();
      await client.close();
      assert.ok(Date.now() - started < 3000, `close took ${Date.now() - started} ms`);
      assert.equal(client.state, 'closed');
      await assert.rejects(readdir(home), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'real SRT: failed startup awaits acknowledged teardown before cleanupConfirmed',
  { skip: !enabled, timeout: 15000 },
  async () => {
    await assert.rejects(
      Sandbox.create({
        cwd: path.join(os.tmpdir(), `pi-srt-no-such-project-${Date.now()}`),
        experimentalWindowsAccepted,
      }),
      (e: unknown) => e instanceof SandboxError && e.code === 'ENOENT' && e.cleanupConfirmed === true,
    );
  },
);
