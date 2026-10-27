// Run against the installed artifact with Electron as Node. No workspace
// node_modules may be needed by these Nx/esbuild outputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [backend, icon] = process.argv.slice(2);
const piDir = join(backend, 'assets/pi');
const load = (path) => import(pathToFileURL(join(piDir, 'dist', path)).href);
const manifest = JSON.parse(readFileSync(join(piDir, 'package.json'), 'utf8'));
assert.ok(!existsSync(join(backend, 'node_modules/@earendil-works/pi-coding-agent')), 'Pi must be built, not copied into node_modules');
for (const entry of [manifest.bin.pi, manifest.exports['./rpc-entry'].import]) {
  const version = execFileSync(process.execPath, [join(piDir, entry), '--version'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(version.trim(), manifest.version);
}
console.log('built Pi CLI and RPC entrypoints: version OK');

const pi = await load('index.js');
pi.initTheme('dark', false);
assert.equal(pi.VERSION, manifest.version);
assert.equal(typeof pi.createAgentSession, 'function');
await load('mcp.js');
console.log('Pi SDK, theme and MCP bundle: imports OK');

const resized = await pi.resizeImage(readFileSync(icon), 'image/png', { maxWidth: 32, maxHeight: 32 });
assert.ok(resized?.wasResized && resized.width <= 32 && resized.height <= 32);
console.log('image worker + packaged Photon WASM: resize OK');

const { CodemodeSandbox, getCodemodeWorkerSpecifier, getQuickJSWasmPath } = await load('codemode.js');
const sandbox = new CodemodeSandbox({ workerUrl: getCodemodeWorkerSpecifier(), wasm: WebAssembly.compile(readFileSync(getQuickJSWasmPath())) });
try {
  const result = await sandbox.execute('text(6 * 7)', { timeoutMs: 5000 });
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.output.some((item) => item.type === 'text' && item.text === '42'), JSON.stringify(result));
  console.log('codemode worker + packaged QuickJS WASM: execution OK');
} finally {
  await sandbox.close();
}

const needleDir = join(backend, 'assets/needle');
const needle = await import(pathToFileURL(join(needleDir, 'dist/index.js')).href);
assert.equal(typeof needle.createWhistle, 'function');
assert.ok(existsSync(join(needleDir, 'vendor/needle.wasm')));
const { default: createNeedleWasm } = await import(pathToFileURL(join(needleDir, 'vendor/needle.cjs')).href);
const engine = await createNeedleWasm({ wasmBinary: readFileSync(join(needleDir, 'vendor/needle.wasm')) });
assert.equal(typeof engine._needle_init, 'function');
// A missing model must be reported by the working worker, not a module/asset
// resolution failure. No model or WASM downloads are allowed by this check.
await assert.rejects(needle.createWhistle({ modelPath: join(backend, 'missing-smoke-model.cact') }), /Model not found/);
console.log('audio worker + packaged Needle WASM: available without downloading the engine');
