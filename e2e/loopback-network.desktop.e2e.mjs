// No backend/model required: reproduce HTTP/1.1 starvation with real Chromium sockets.
// Run directly: node --test e2e/loopback-network.desktop.e2e.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { _electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('loopback streams cannot starve health and ordinary API requests across desktop windows', { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-kit-network-'));
  const entry = join(scratch, 'main.cjs');
  let app;
  try {
    await build({
      stdin: {
        resolveDir: root,
        contents: `
          import { app, BrowserWindow } from 'electron';
          import { createServer } from 'node:http';
          import { configureLoopbackConnections } from './apps/desktop/src/loopback-network';
          configureLoopbackConnections(app.commandLine);
          app.setPath('userData', ${JSON.stringify(join(scratch, 'profile'))});
          app.whenReady().then(() => {
            const server = createServer((request, response) => {
              if (request.url.startsWith('/stream/')) {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.write('data: ready\\n\\n');
              } else if (request.url === '/api/health') response.end('ok');
              else response.end('<!doctype html><title>Network regression</title>');
            });
            server.listen(0, '127.0.0.1', () => {
              const url = 'http://127.0.0.1:' + server.address().port;
              for (let i = 0; i < 2; i++) {
                new BrowserWindow({ show: false }).loadURL(url + '/window/' + i);
              }
            });
          });
        `,
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [entry], env });
    // Each window keeps four responses open. With the default six-slot pool,
    // the second window's remaining streams and its health request never send.
    const first = await app.firstWindow();
    await first.waitForLoadState();
    const second = await app.waitForEvent('window', {
      predicate: (page) => page !== first,
      timeout: 5000,
    }).catch(() => app.windows().find((page) => page !== first));
    assert.ok(second, 'the second renderer exists');
    await second.waitForLoadState();
    for (const page of [first, second]) {
      const result = await page.evaluate(async () => {
        window.streamAbort = new AbortController();
        window.openStreams = [];
        try {
          await Promise.all(Array.from({ length: 4 }, async (_, i) => {
            const response = await fetch('/stream/' + i, {
              signal: AbortSignal.any([window.streamAbort.signal, AbortSignal.timeout(5000)]),
            });
            // Keep bodies referenced and unread, just like long-lived event feeds.
            window.openStreams.push(response);
          }));
          const health = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
          return { streams: window.openStreams.length, health: await health.text() };
        } catch (error) {
          return { streams: window.openStreams.length, error: error.name };
        }
      });
      assert.deepEqual(result, { streams: 4, health: 'ok' });
    }
    // Close one window's streams; the other window must remain usable.
    await first.evaluate(() => window.streamAbort.abort());
    assert.equal(await second.evaluate(async () => (await fetch('/api/health', { signal: AbortSignal.timeout(1500) })).text()), 'ok');
    await second.evaluate(() => window.streamAbort.abort());
  } finally {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
