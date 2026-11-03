// Run directly: node --test e2e/browser-rendering.desktop.e2e.mjs
// Builds a tiny real-Electron probe; no backend build, model, fixture Git commit or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import electron from 'electron';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

it('renders current pixels and AX while hidden, attached, resized and hidden again; recovers from a stalled action', { timeout: 120_000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'pi-kit-browser-rendering-'));
  let child;
  try {
    await build({
      absWorkingDir: root,
      entryPoints: {
        main: 'e2e/support/browser-rendering-probe.ts',
        'screenshot-encoder-preload': 'apps/desktop/src/screenshot-encoder-preload.ts',
      },
      outdir: out, outExtension: { '.js': '.cjs' }, bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], target: 'node24', logLevel: 'silent',
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(electron, [join(out, 'main.cjs'), `--user-data-dir=${join(out, 'profile')}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 90_000);
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(exit.code, 0, `Native regression failed (${exit.signal ?? exit.code}):\n${output}`);
      for (const mode of ['initially-hidden', 'visible', 'hidden-again', 'scrolled selection and tall fullpage', 'stalled navigation', 'stalled native screenshot']) assert.ok(output.includes(`PASS ${mode}`), output);
    } finally { clearTimeout(deadline); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(out, { recursive: true, force: true });
  }
});
