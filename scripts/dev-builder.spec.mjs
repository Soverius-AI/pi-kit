import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function renderer(overrides = {}) {
  const env = { ...process.env, NX_DAEMON: 'false', PORT: '4200' };
  delete env.PI_KIT_DEV_RENDERER_PORT;
  Object.assign(env, overrides);
  const child = fork(fileURLToPath(new URL('./dev-builder.mjs', import.meta.url)), [], { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = '';
  const capture = (chunk) => { log = (log + chunk).slice(-16000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Renderer did not start:\n${log}`)), 60000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Renderer exited ${code}:\n${log}`)); });
    child.on('message', (message) => {
      if (message.type === 'renderer-ready') { clearTimeout(timer); resolve(message.url); }
    });
  });
  return { child, ready };
}

async function stop(child, disconnect = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (disconnect) child.disconnect();
  else child.kill('SIGTERM');
  await exited;
}

test('desktop renderers bind independent ports with 4200 occupied, report the real URL, honor an override and release their sockets', { timeout: 120000 }, async () => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', (error) => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    occupied.listen(4200, 'localhost', resolve);
  });
  const children = [];
  try {
    const first = renderer();
    children.push(first.child);
    const url1 = await first.ready;
    const second = renderer();
    children.push(second.child);
    const url2 = await second.ready;
    assert.notEqual(new URL(url1).port, '4200');
    assert.notEqual(new URL(url2).port, '4200');
    assert.notEqual(url1, url2);
    for (const url of [url1, url2]) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /pk-root/);
    }
    await stop(first.child);
    await assert.rejects(fetch(url1, { signal: AbortSignal.timeout(2000) }));
    const explicit = renderer({ PI_KIT_DEV_RENDERER_PORT: new URL(url1).port });
    children.push(explicit.child);
    assert.equal(await explicit.ready, url1, 'Electron receives the actual explicit origin, rather than a guessed default');
    assert.equal((await fetch(url1)).status, 200);
    await stop(second.child, true);
    await assert.rejects(fetch(url2, { signal: AbortSignal.timeout(2000) }));
  } finally {
    await Promise.all(children.map((child) => stop(child)));
    if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
  }
});
