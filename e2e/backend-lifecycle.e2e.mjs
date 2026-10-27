// Real process and encrypted storage proof: parent loss must flush the terminal's pending replay through Nest hooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { createWorld, root } from './support/env.mjs';

test('parent loss flushes unsaved terminal replay before the backend exits', async () => {
  const world = createWorld({ offline: true });
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const backend = spawn(process.execPath, ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(port), PI_KIT_ORIGIN: `http://localhost:${port}`, PI_KIT_PARENT_PID: String(parent.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [backend.stdout, backend.stderr]) stream.on('data', (data) => { log = (log + data).slice(-24_000); });
  const exited = once(backend, 'exit');
  const headers = { Authorization: `Bearer ${world.env.PI_KIT_TOKEN}`, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${port}/api`;
  const marker = 'PK_SHUTDOWN_FLUSH';
  const streamAbort = new AbortController();
  const call = async (path, body) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.text()}`);
  };
  const replay = () => {
    const key = JSON.parse(readFileSync(world.env.PI_KIT_SECRET_STORE.slice(5), 'utf8'))['pi-kit/db'];
    assert.match(key, /^[0-9a-f]{64}$/);
    const db = new Database(join(world.data, 'pi-kit.sqlite'), { readonly: true, fileMustExist: true });
    try {
      db.pragma("cipher='chacha20'");
      db.pragma(`key="x'${key}'"`);
      return db.prepare('SELECT data FROM terminal_replay WHERE cwd = ?').get(world.project)?.data ?? '';
    } finally { db.close(); }
  };
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (backend.exitCode !== null || backend.signalCode) throw new Error(`Backend exited before health was ready.\n${log}`);
      try { if ((await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(500) })).ok) break; } catch { /* startup */ }
      if (Date.now() > deadline) throw new Error(`Backend did not start.\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await call('/workspaces', { cwd: world.project });
    const terminal = `/workspaces/${encodeURIComponent(world.project)}/terminal`;
    await call(terminal, { cols: 80, rows: 24 });
    const response = await fetch(`${url}${terminal}/stream`, { headers, signal: streamAbort.signal });
    const reader = response.body.getReader();
    await call(`${terminal}/input`, { data: `printf '\\n${marker}\\n'\r` });
    let output = '';
    while (!output.includes(marker)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'terminal closed before it produced output');
      output += Buffer.from(chunk.value).toString();
    }
    assert.equal(replay().includes(marker), false, 'the replay is still pending; an ordinary debounce save cannot satisfy this test');
    streamAbort.abort();
    parent.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.ok(code === 0 || signal === 'SIGTERM', `Backend did not finish its normal shutdown: ${code}/${signal}\n${log}`);
    assert.match(log, /requesting Nest shutdown/);
    assert.ok(replay().includes(marker), `The pending terminal screen was not flushed.\n${log}`);
  } finally {
    streamAbort.abort();
    parent.kill('SIGKILL');
    if (backend.exitCode === null && !backend.signalCode) { backend.kill('SIGKILL'); await exited; }
    world.dispose();
  }
});
