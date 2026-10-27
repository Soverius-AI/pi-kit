// pnpm run e2e
//
// Starts `pnpm run dev:web` against a scratch pi agent folder and a scratch git project (e2e/support/env.mjs), runs the Playwright tests in
// e2e/ with Node's test runner, and stops everything. It needs one local model behind the llama-swap at http://127.0.0.1:8080/v1 (E2E_MODEL_URL):
// E2E_MODEL_ID, or else the first Flint model it lists (the fastest here), else the first Gemma 4. The scratch worlds name their models gemma-4-26b, llama3.2 and qwen3.8-27b (the picker, ⌘⇧M and the
// thinking tests need three); a proxy in front of llama-swap answers all of them with that one model. It also needs `pnpm exec playwright install chromium`
// once. The server's log is kept in the scratch folder and printed when a test fails.
//
//   pnpm run e2e                      all tests
//   pnpm run e2e -- --grep "tree"     only tests whose name matches
//   pnpm run e2e -- --file update     only e2e/update.e2e.mjs, or several in order with --file app,update (a file that has no matching test never runs its `after` hook, so a grep that matches nothing in a file hangs on its browser)
//   pnpm run e2e -- --shards 3        the files split over 3 runners at once: the backend is built once, one renderer serves them all, and each
//                                     runner has its own scratch world and backend (port 4300, 4400, 4500, …); the z-* files stay together and last
//   E2E_REPORTER=tap pnpm run e2e    print failure details as each test file finishes
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startKeyProxy } from '../e2e/support/key-proxy.mjs';

const { values } = parseArgs({
  options: {
    grep: { type: 'string' },
    file: { type: 'string' },
    keep: { type: 'boolean', default: false },
    shards: { type: 'string', default: '1' },
    reporter: { type: 'string', default: process.env.E2E_REPORTER ?? 'spec' },
  },
});
/** Set by a sharded parent: the proxy is its, the renderer is its, and this runner starts only a backend. */
const SHARD = process.env.E2E_SHARD;

// ---- the one real model, behind a proxy every world uses (a shard reuses its parent's)
let proxy;
let real = process.env.E2E_REAL_MODEL;
if (!SHARD) {
  const upstream = process.env.E2E_MODEL_URL ?? 'http://127.0.0.1:8080/v1';
  let listed;
  try {
    const res = await fetch(`${upstream}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    listed = ((await res.json()).data ?? []).map((model) => model.id);
  } catch (error) {
    console.error(`The e2e tests need a local model at ${upstream} (set E2E_MODEL_URL): ${error.message}`);
    process.exit(2);
  }
  real = process.env.E2E_MODEL_ID?.trim() || listed.find((id) => /flint/i.test(id)) || listed.find((id) => /gemma-?4/i.test(id));
  if (!real) {
    console.error(`No Flint or Gemma 4 model among the models at ${upstream} (${listed.join(', ')}): set E2E_MODEL_ID to the one the tests should use.`);
    process.exit(2);
  }
  // Every model name of the scratch worlds is answered by the one real model; the worlds and the test processes find the proxy through E2E_MODEL_URL.
  proxy = await startKeyProxy(upstream, real);
  process.env.E2E_MODEL_URL = proxy.url;
  process.env.E2E_REAL_MODEL = real;
  // The real server, for tests about finding local servers (the app scans their usual ports, not the proxy).
  process.env.E2E_UPSTREAM_MODEL_URL = upstream;
}
const { RENDERER, BACKEND, MODEL, createWorld, isUp, root, startBackend, startDevWeb } = await import('../e2e/support/env.mjs');

const shards = Math.max(1, Number(values.shards) || 1);
const code = shards > 1 && !SHARD ? await runShards(shards) : await runOne();
await proxy?.close();
process.exit(code);

/** One runner: a scratch world, its dev server (or, in a shard, its backend only) and the test files in order. */
async function runOne() {
  console.log(`${SHARD ? `[shard ${SHARD}] ` : ''}Scratch default model: ${MODEL.provider}/${MODEL.id}, answered by ${real}; backend ${BACKEND}`);
  const world = createWorld();
  const logPath = join(world.base, 'dev-web.log');
  const log = openSync(logPath, 'w');
  let server;
  let code = 1;
  try {
    server = SHARD ? await startBackend(world, { log }) : await startDevWeb(world, { log });
    const files = values.file ? values.file.split(',').map((name) => join(root, 'e2e', `${name.trim()}.e2e.mjs`)) : [join(root, 'e2e', '*.e2e.mjs')];
    const args = ['--test', '--test-concurrency=1', `--test-reporter=${values.reporter}`, ...(values.grep ? ['--test-name-pattern', values.grep] : []), ...files];
    const child = spawn('node', args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, E2E_BASE: RENDERER, E2E_API: BACKEND, E2E_AGENT_DIR: world.agent, E2E_PROJECT: world.project, E2E_DATA_DIR: world.data, E2E_ENV: JSON.stringify(world.env), E2E_LOG: logPath },
    });
    code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
    if (code !== 0) console.error(`\nServer log: ${logPath}\n${readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')}`);
  } finally {
    server?.stop();
    if (!values.keep && code === 0) world.dispose();
    else console.error(`Scratch folder kept: ${world.base}`);
  }
  return code;
}

/**
 * The files split over `count` runners. Files are weighed by size (the long ones are the slow ones); the z-* files are one unit, since they
 * rely on running last and in order. Each runner keeps its files in name order, and writes its output to a log of its own.
 */
async function runShards(count) {
  const names = values.file
    ? values.file.split(',').map((name) => name.trim())
    : readdirSync(join(root, 'e2e')).filter((name) => name.endsWith('.e2e.mjs')).map((name) => name.replace(/\.e2e\.mjs$/, '')).sort();
  const weigh = (name) => statSync(join(root, 'e2e', `${name}.e2e.mjs`)).size;
  const units = [...names.filter((name) => !name.startsWith('z-')).map((name) => [name]), names.filter((name) => name.startsWith('z-'))].filter((unit) => unit.length);
  const groups = Array.from({ length: count }, () => ({ names: [], weight: 0 }));
  for (const unit of units.toSorted((a, b) => b.reduce((n, f) => n + weigh(f), 0) - a.reduce((n, f) => n + weigh(f), 0))) {
    const lightest = groups.reduce((a, b) => (b.weight < a.weight ? b : a));
    lightest.names.push(...unit);
    lightest.weight += unit.reduce((n, f) => n + weigh(f), 0);
  }
  for (const group of groups) group.names.sort((a, b) => (a.startsWith('z-') === b.startsWith('z-') ? a.localeCompare(b) : a.startsWith('z-') ? 1 : -1));

  // Built once: the shards run `dist/apps/backend` as it is, and one renderer dev server serves every shard (the page is told its backend).
  console.log('Building the backend once for every shard…');
  if (spawnSync('pnpm', ['exec', 'nx', 'build', 'backend', '--configuration=development'], { cwd: root, stdio: 'inherit' }).status !== 0) return 1;
  if (await isUp(RENDERER)) {
    console.error(`The renderer port of ${RENDERER} is in use already. Stop the running dev:web first.`);
    return 1;
  }
  const renderer = spawn('pnpm', ['exec', 'nx', 'serve', 'renderer', '--port', new URL(RENDERER).port], { cwd: root, stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 600 && !(await isUp(RENDERER)); i++) await new Promise((resolve) => setTimeout(resolve, 500));
    const basePort = Number(new URL(BACKEND).port);
    const runs = groups.filter((group) => group.names.length).map((group, index) => {
      const logPath = join(tmpdir(), `pi-kit-e2e-shard-${index + 1}.log`);
      console.log(`shard ${index + 1}: backend :${basePort + 100 * index}, ${group.names.length} files (${group.names.join(', ')}); output in ${logPath}`);
      const out = openSync(logPath, 'w');
      const child = spawn('node', ['scripts/e2e.mjs', '--file', group.names.join(','), '--reporter', values.reporter, ...(values.grep ? ['--grep', values.grep] : []), ...(values.keep ? ['--keep'] : [])], {
        cwd: root,
        stdio: ['ignore', out, out],
        env: { ...process.env, E2E_SHARD: String(index + 1), PI_KIT_DEV_BACKEND_PORT: String(basePort + 100 * index) },
      });
      return new Promise((resolve) => child.on('exit', (c) => {
        const text = readFileSync(logPath, 'utf8');
        const summary = ['pass', 'fail', 'cancelled'].map((kind) => text.match(new RegExp(`^(?:#|ℹ) ${kind} (\\d+)`, 'm'))?.[1] ?? '?');
        console.log(`shard ${index + 1} done: exit ${c}, pass ${summary[0]}, fail ${summary[1]}, cancelled ${summary[2]} (${logPath})`);
        resolve(c ?? 1);
      }));
    });
    const codes = await Promise.all(runs);
    return codes.every((c) => c === 0) ? 0 : 1;
  } finally {
    try {
      process.kill(-renderer.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}
