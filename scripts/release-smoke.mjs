// Smoke test of a packaged build.
//
//   node scripts/release-smoke.mjs <artifact|dir> [--timeout 90] [--keep] [--updates]
//   --updates also exercises Update all, downloading a managed Pi release and refreshing model catalogs (network required).
//
//   <dir>       an unpacked app (dist/release/mac-arm64, .../pi-kit.app, dist/release/win-unpacked) or dist/release itself, which picks this machine's target
//   <artifact>  macOS .zip/.dmg, Linux .AppImage (extracted without FUSE), or the Windows NSIS installer (silent install into a temp folder)
//
// What it does, with nothing outside a temp folder touched (no ~/.pi/agent, no OS keychain, no network: PI_OFFLINE=1, a model on 127.0.0.1):
//   1. writes a scratch pi agent folder whose only model is a tiny OpenAI-compatible server this script runs (or E2E_MODEL_URL, the llama-swap the e2e uses),
//   2. launches the app with PI_KIT_SMOKE=1, PI_CODING_AGENT_DIR, PI_KIT_DATA_DIR and a file secret store in the temp folder,
//   3. waits for smoke.json (the main process writes it once the backend is healthy and <pk-root> has drawn), then asserts /api/health (401 without the token),
//   4. loads the app's own native modules with the app binary as Node (better-sqlite3-multiple-ciphers, @napi-rs/keyring, node-pty, a pty spawn on macOS),
//   5. installs an extension through host npm from a loopback registry, then creates a thread and sends one prompt through the real runtime,
// and, with the built-in fake model, has the main agent spawn one background agent and waits for it to finish,
//   6. quits the app the way a user would (SIGTERM = Cmd+Q on macOS/Linux, `taskkill` = closing the window on Windows) and asserts a clean exit and no backend left.
// On macOS it also prints codesign / spctl for the app. Windows paths (installer, taskkill) are written but have not been run on Windows.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadInElectron } from './natives.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { timeout: { type: 'string', default: '90' }, keep: { type: 'boolean', default: false }, updates: { type: 'boolean', default: false } },
});
if (!positionals[0]) {
  console.error('Usage: node scripts/release-smoke.mjs <artifact|dir> [--timeout 90] [--keep] [--updates]');
  process.exit(2);
}
const TIMEOUT_MS = Number(values.timeout) * 1000;
const target = resolve(positionals[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timings = {};
const clock = (label) => {
  const t0 = Date.now();
  return () => (timings[label] = Date.now() - t0);
};
const log = (line) => console.log(line);
const cleanups = [];
let failed;

async function main() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pi-kit-smoke-')));
  cleanups.push(() => (values.keep ? log(`kept ${scratch}`) : rmSync(scratch, { recursive: true, force: true })));
  const app = prepareApp(target, scratch);
  log(`app: ${app.exe}`);
  if (process.platform === 'darwin' && app.bundle) macSigning(app.bundle);

  // ---- the model
  const model = await startModel();
  cleanups.push(() => model.close());
  const world = writeWorld(scratch, model);
  log(`model: ${model.external ? 'E2E_MODEL_URL ' : 'built-in fake at '}${model.baseUrl} (${model.id})`);
  const packages = await startPackageRegistry(scratch);
  cleanups.push(() => packages.close());

  // ---- launch
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_KIT_') || key === 'PI_CODING_AGENT_DIR' || key === 'ELECTRON_RUN_AS_NODE' || key === 'PI_OFFLINE') delete env[key];
  Object.assign(env, world.env, packages.env, { PI_KIT_SMOKE: '1', PI_OFFLINE: '1' });
  // Finder does not inherit the developer terminal's PATH. The app must recover
  // the host tools from the login shell before its backend can spawn npm.
  if (process.platform === 'darwin') env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const stopLaunch = clock('launch to ready');
  const child = spawn(app.exe, [], { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (d) => (output = (output + d).slice(-6000)));
  child.stderr.on('data', (d) => (output = (output + d).slice(-6000)));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  cleanups.push(() => child.exitCode === null && child.kill('SIGKILL'));
  let appExit;
  void exited.then((e) => (appExit = e));

  const smokeFile = join(world.data, 'smoke.json');
  const deadline = Date.now() + TIMEOUT_MS;
  while (!existsSync(smokeFile)) {
    if (appExit) throw new Error(`The app exited (${JSON.stringify(appExit)}) before it was ready.\n${diagnostics(world, output)}`);
    if (Date.now() > deadline) throw new Error(`No smoke.json after ${TIMEOUT_MS / 1000} s.\n${diagnostics(world, output)}`);
    await sleep(250);
  }
  stopLaunch();
  const report = JSON.parse(readFileSync(smokeFile, 'utf8'));
  log(`ready: pid ${report.pid}, backend pid ${report.backendPid}, ${report.platform}-${report.arch}, electron ${report.electron}, version ${report.version}, ${report.window.url}`);
  check(report.packaged === true, 'the app reports packaged = true');
  check(report.platform === process.platform && report.arch === process.arch, `the app runs as ${process.platform}-${process.arch}`, `it says ${report.platform}-${report.arch}`);
  check(report.window.url.startsWith('app://pi-kit/'), 'the window loaded the renderer from app://pi-kit/', report.window.url);
  check(report.window.rootChildren > 0, '<pk-root> has drawn (the Angular build served from app.asar started)');
  check(report.splash?.loaded && report.splash?.shown, 'the packaged splash loaded and was shown', JSON.stringify(report.splash));
  check(report.window.backendStatus === 200, 'the renderer reaches the backend through the preload and browser fetch', report.window.backendError ?? report.window.backendStatus);

  // ---- the backend
  const authed = { Authorization: `Bearer ${report.token}` };
  const stopHealth = clock('health');
  const health = await fetch(`${report.url}/api/health`, { headers: authed });
  stopHealth();
  check(health.status === 200, 'GET /api/health with the token answers 200', health.status);
  const anonymous = await fetch(`${report.url}/api/health`);
  check(anonymous.status === 401, 'GET /api/health without the token answers 401', anonymous.status);
  log(`health: ${JSON.stringify(await health.json())}`);
  const about = await fetch(`${report.url}/api/about`, { headers: authed });
  if (about.ok) log(`about: ${JSON.stringify(await about.json()).slice(0, 300)}`);
  const swagger = await fetch(`${report.url}/api/docs`, { headers: authed });
  check(swagger.status === 404, 'the Swagger UI is not mounted in a packaged app (GET /api/docs answers 404)', swagger.status);

  // ---- natives, loaded by the packaged app's own binary (hardened runtime and library validation apply on macOS)
  if (app.backend) {
    const stopNatives = clock('natives load');
    loadInElectron({ backend: app.backend, electron: app.exe, log, label: 'packaged app' });
    const runtime = execFileSync(app.exe, [join(root, 'scripts/package-runtime-check.mjs'), app.backend, join(root, 'apps/desktop/build/icon.png')], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: scratch, encoding: 'utf8', timeout: 30_000,
    });
    log(runtime.trim());
    stopNatives();
  }

  // ---- install an extension with the host npm, entirely within the scratch world
  const installed = await fetch(`${report.url}/api/packages?cwd=${encodeURIComponent(world.project)}`, {
    method: 'POST', headers: { ...authed, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: packages.source, scope: 'user' }), signal: AbortSignal.timeout(30_000),
  });
  const installation = await installed.json();
  check(installed.status === 200, 'the packaged app installs an npm extension', JSON.stringify(installation));
  check(installation.overview.packages.some((pkg) => pkg.source === packages.source && pkg.installed), 'the installed extension is listed');

  packages.publishNext();
  const targets = values.updates ? ['pi', 'packages', 'models', 'app'] : ['packages'];
  const update = await fetch(`${report.url}/api/update`, {
    method: 'POST', headers: { ...authed, 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }),
  });
  check(update.status === 201, 'the settings update job starts', await update.text());
  const updateDeadline = Date.now() + (values.updates ? 180_000 : 30_000);
  let updateStatus;
  do {
    updateStatus = await (await fetch(`${report.url}/api/update/status`, { headers: authed })).json();
    if (updateStatus.job?.state !== 'running') break;
    await sleep(250);
  } while (Date.now() < updateDeadline);
  check(updateStatus.job?.state === 'done', `${values.updates ? 'Update all' : 'Update packages'} completes`, JSON.stringify(updateStatus.rows));
  const updatedExtension = JSON.parse(readFileSync(join(world.agent, 'npm/node_modules/pi-kit-smoke-extension/package.json'), 'utf8'));
  check(updatedExtension.version === '1.0.1', 'the settings updater installs the newer extension version');
  if (values.updates) {
    check(updateStatus.rows.find((row) => row.target === 'pi')?.state === 'done', 'the managed Pi release is installed');
    check(updateStatus.rows.find((row) => row.target === 'models')?.state === 'done', 'the model catalogs refresh');
    const appRow = updateStatus.rows.find((row) => row.target === 'app');
    check(['done', 'unavailable'].includes(appRow?.state), 'the app update finishes or explains why its release feed is unavailable', JSON.stringify(appRow));
  }

  // ---- a thread and one prompt through the bundled pi
  const nonce = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  const created = await fetch(`${report.url}/api/threads`, { method: 'POST', headers: { ...authed, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: world.project, title: 'smoke' }) });
  check(created.status === 201, 'POST /api/threads answers 201', created.status === 201 ? '' : `${created.status}: ${await created.text()}`);
  const thread = await created.json();
  log(`thread: ${thread.id}`);
  const stopRun = clock('prompt to answer');
  const answer = await runPrompt(report.url, authed, thread.id, `Reply with the word ${nonce}.`);
  stopRun();
  log(`answer: ${JSON.stringify(answer.text)} (${answer.events} events)`);
  check(answer.finished, 'the run finished (RUN_FINISHED)', answer.error ?? 'no RUN_FINISHED event');
  check(answer.text.trim().length > 0, 'the assistant answered with text');
  check(existsSync(packages.loaded), 'the installed TypeScript extension loaded with the bundled Pi APIs');
  if (!model.external) {
    check(answer.text.includes(nonce), 'the fake model echoed the prompt: it went through pi to the model and back', `${JSON.stringify(answer.text)} lacks ${nonce}`);
    check(model.requests() >= 1, 'the model server saw the request');
  }
  const list = await (await fetch(`${report.url}/api/threads`, { headers: authed })).json();
  check(Array.isArray(list) && list.some((t) => t.id === thread.id), 'the thread is listed');

  // ---- one background agent: opt in for the project, ask the main agent to spawn one, wait for it to finish
  if (!model.external) {
    const health = await (await fetch(`${report.url}/api/health`, { headers: authed })).json();
    check(health.backgroundAgents?.enabled === true, 'the packaged backend owns the background agents store', JSON.stringify(health.backgroundAgents));
    // The packaged app runs as production, where the test flag PI_KIT_TRUSTED_CWDS is ignored: trust the folder as a user would.
    const trust = await fetch(`${report.url}/api/workspaces/${encodeURIComponent(world.project)}/trust`, { method: 'POST', headers: { ...authed, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'remember' }) });
    const trusted = trust.ok ? await trust.json() : undefined;
    check(trusted?.status === 'trusted', 'the project is trusted through the API (the packaged app ignores PI_KIT_TRUSTED_CWDS)', trust.ok ? JSON.stringify(trusted) : `${trust.status}: ${await trust.text()}`);
    const optIn = await fetch(`${report.url}/api/workspaces`, { method: 'PATCH', headers: { ...authed, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: world.project, agents: true }) });
    check(optIn.ok, 'the project opts in to background agents', optIn.ok ? '' : `${optIn.status}: ${await optIn.text()}`);
    const stopAgent = clock('agent spawn to done');
    const spawnRun = await runPrompt(report.url, authed, thread.id, 'Please spawn a background agent named smoke that says done.');
    check(spawnRun.finished && /Started the smoke agent/.test(spawnRun.text), 'the main agent spawned the agent and said so', JSON.stringify(spawnRun.text));
    let agents = [];
    const agentDeadline = Date.now() + 60_000;
    while (Date.now() < agentDeadline) {
      agents = await (await fetch(`${report.url}/api/threads/${thread.id}/agents`, { headers: authed })).json();
      if (agents.some((a) => a.status === 'done')) break;
      await sleep(500);
    }
    stopAgent();
    check(agents.length === 1 && agents[0].name === 'smoke' && agents[0].status === 'done', 'the background agent ran in the packaged app and finished', JSON.stringify(agents.map((a) => [a.name, a.status])));
    log(`agent: ${agents[0]?.name} ${agents[0]?.status} (${agents[0]?.turns} turn)`);
  }
  check(existsSync(join(world.data, 'pi-kit.sqlite')), 'the database pi-kit.sqlite was created in the scratch data folder', readdirSync(world.data).join(', '));

  // ---- quit like a user
  const stopQuit = clock('quit');
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(report.pid)], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  const result = await Promise.race([exited, sleep(30_000).then(() => undefined)]);
  stopQuit();
  check(result !== undefined, 'the app quit within 30 s of the quit request', 'still running');
  check(result.code === 0, 'the app exited with code 0', JSON.stringify(result));
  let backendGone = false;
  for (let i = 0; i < 40 && !backendGone; i++) {
    backendGone = !alive(report.backendPid);
    if (!backendGone) await sleep(250);
  }
  check(backendGone, `the backend (pid ${report.backendPid}) is gone after the app quit`, 'still running');
  check(!(await fetch(`${report.url}/api/health`, { headers: authed }).then(() => true, () => false)), 'the backend port no longer answers');
  log(`quit: exit code ${result.code}, backend gone`);
}

// ------------------------------------------------------------------------------------------------------------------ app location

/** Returns { exe, bundle?, backend? } for a directory or an artifact, unpacking into `scratch` when needed. */
function prepareApp(path, scratch) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const lower = path.toLowerCase();
  if (lower.endsWith('.appimage')) {
    if (process.platform !== 'linux') throw new Error('An AppImage can only be opened on Linux');
    execFileSync(path, ['--appimage-extract'], { cwd: scratch, stdio: ['ignore', 'ignore', 'pipe'] });
    log(`extracted ${basename(path)}`);
    return fromDir(join(scratch, 'squashfs-root'));
  }
  if (lower.endsWith('.zip')) {
    const out = join(scratch, 'unzipped');
    mkdirSync(out);
    if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', path, out]);
    else execFileSync('tar', ['-xf', path, '-C', out]);
    log(`unzipped ${basename(path)}`);
    return fromDir(out);
  }
  if (lower.endsWith('.dmg')) {
    if (process.platform !== 'darwin') throw new Error('A .dmg can only be opened on macOS');
    const mount = join(scratch, 'dmg');
    mkdirSync(mount);
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mount, path], { stdio: 'ignore' });
    try {
      const bundle = readdirSync(mount).find((f) => f.endsWith('.app'));
      if (!bundle) throw new Error(`No .app in ${basename(path)}`);
      const out = join(scratch, 'from-dmg');
      mkdirSync(out);
      execFileSync('ditto', [join(mount, bundle), join(out, bundle)]);
      log(`copied ${bundle} out of ${basename(path)}`);
      return fromDir(out);
    } finally {
      execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' });
    }
  }
  if (lower.endsWith('.exe')) {
    if (process.platform !== 'win32') throw new Error('A Windows installer can only be run on Windows');
    if (lower.includes('portable')) throw new Error('Smoke-test the unpacked folder (win-unpacked) or the installer, not the portable exe');
    const out = join(scratch, 'installed');
    // NSIS: /S silent, /D= the install folder (must be last and unquoted).
    execFileSync(path, ['/S', `/D=${out}`], { stdio: 'inherit', windowsHide: true });
    cleanups.push(() => {
      const uninstaller = join(out, 'Uninstall pi-kit.exe');
      if (existsSync(uninstaller)) spawnSync(uninstaller, ['/S'], { stdio: 'ignore' });
    });
    return fromDir(out);
  }
  return fromDir(path);
}

function fromDir(dir) {
  const appName = dir.endsWith('.app') ? undefined : readdirSync(dir).find((f) => f.endsWith('.app'));
  const bundle = dir.endsWith('.app') ? dir : appName ? join(dir, appName) : undefined;
  if (bundle) return { exe: join(bundle, 'Contents', 'MacOS', 'pi-kit'), bundle, backend: join(bundle, 'Contents', 'Resources', 'backend') };
  if (existsSync(join(dir, 'pi-kit.exe'))) return { exe: join(dir, 'pi-kit.exe'), backend: join(dir, 'resources', 'backend') };
  if (existsSync(join(dir, 'pi-kit'))) return { exe: join(dir, 'pi-kit'), backend: join(dir, 'resources', 'backend') };
  // dist/release itself: this machine's own unpacked target
  const own = process.platform === 'darwin' ? [`mac-${process.arch}`] : process.platform === 'win32' ? [process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'] : [process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'];
  for (const name of own) if (existsSync(join(dir, name))) return fromDir(join(dir, name));
  throw new Error(`Found no pi-kit app in ${dir} (looked for pi-kit.app, pi-kit.exe, and ${own.join(', ')})`);
}

function macSigning(bundle) {
  const run = (command, args) => {
    const r = spawnSync(command, args, { encoding: 'utf8' });
    return `${(r.stdout || '') + (r.stderr || '')}`.trim();
  };
  log('--- codesign -dv');
  log(run('codesign', ['-dv', '--verbose=2', bundle]));
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', bundle], { encoding: 'utf8' });
  log(`--- codesign --verify --deep --strict: ${verify.status === 0 ? 'valid on disk, satisfies its Designated Requirement' : (verify.stderr || verify.stdout).trim()}`);
  check(verify.status === 0, 'codesign --verify --deep --strict passes', (verify.stderr || verify.stdout).trim());
  log('--- spctl --assess (Gatekeeper; an ad-hoc signed build is expected to be rejected: only a Developer ID + notarization passes)');
  log(run('spctl', ['--assess', '--type', 'execute', '-vv', bundle]) || '(no output)');
}

// ------------------------------------------------------------------------------------------------------------------ scratch world and model

/** A dependency-free extension served to real npm, with no public registry or user npm cache involved. */
async function startPackageRegistry(scratch) {
  const name = 'pi-kit-smoke-extension';
  let version = '1.0.0';
  const loaded = join(scratch, 'extension-loaded.json');
  const folder = join(scratch, 'registry', 'package');
  mkdirSync(folder, { recursive: true });
  const manifest = { name, type: 'module', pi: { extensions: ['./index.ts'] } };
  writeFileSync(join(folder, 'index.ts'), `import { writeFileSync } from 'node:fs';\nimport { Type } from 'typebox';\nexport default function () { writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(Type.String())); }\n`);
  const archive = join(scratch, 'extension.tgz');
  const tarballs = new Map(['1.0.0', '1.0.1'].map((release) => {
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ ...manifest, version: release }));
    execFileSync('tar', ['-czf', archive, '-C', dirname(folder), 'package']);
    return [release, readFileSync(archive)];
  }));
  const server = createServer((req, res) => {
    const release = [...tarballs.keys()].find((candidate) => req.url === `/${name}/-/${name}-${candidate}.tgz`);
    if (release) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(tarballs.get(release));
    }
    if (req.url === `/${name}`) {
      const dist = { tarball: `http://127.0.0.1:${server.address().port}/${name}/-/${name}-${version}.tgz` };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { ...manifest, version, dist } } }));
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = join(scratch, 'npmrc');
  writeFileSync(config, '');
  return {
    source: `npm:${name}`, loaded,
    publishNext() { version = '1.0.1'; },
    env: {
      npm_config_registry: `http://127.0.0.1:${server.address().port}`,
      npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: config,
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
      // --updates installs Pi's official lockfile; keep its registry tarball URLs
      // intact while the test extension continues to use this loopback registry.
      npm_config_replace_registry_host: 'never',
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}

function writeWorld(scratch, model) {
  const agent = join(scratch, 'agent');
  const project = join(scratch, 'project');
  const data = join(scratch, 'data');
  for (const dir of [agent, project, data]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(agent, 'models.json'),
    JSON.stringify({ providers: { 'smoke-model': { baseUrl: model.baseUrl, api: 'openai-completions', apiKey: 'smoke', models: [{ id: model.id, name: 'Smoke model', contextWindow: 32768 }] } } }, null, 2),
  );
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'smoke-model', defaultModel: model.id, defaultThinkingLevel: 'off', enabledModels: [`smoke-model/${model.id}`], lastChangelogVersion: '1.2.0' }, null, 2));
  writeFileSync(join(agent, 'auth.json'), '{}', { mode: 0o600 });
  writeFileSync(join(project, 'README.md'), '# smoke project\n');
  const git = (...args) => spawnSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', 'fixture');
  return {
    agent,
    project,
    data,
    env: {
      PI_CODING_AGENT_DIR: agent,
      PI_KIT_DATA_DIR: data,
      PI_KIT_CWD: project,
      PI_KIT_TRUSTED_CWDS: project,
      // A scratch credential store: the OS keychain is never touched.
      PI_KIT_SECRET_STORE: `file:${join(scratch, 'secrets.json')}`,
      PI_KIT_WORKTREE_ROOT: join(scratch, 'worktrees'),
      PI_KIT_GH: 'none',
      PI_KIT_SKIP_ONBOARDING: '1',
      PI_SKIP_VERSION_CHECK: '1',
    },
  };
}

/** The model: E2E_MODEL_URL (+ E2E_MODEL_ID) when set, else an OpenAI-compatible chat-completions server on 127.0.0.1 that answers "ok <the last user message>". */
async function startModel() {
  if (process.env.E2E_MODEL_URL) return { external: true, baseUrl: process.env.E2E_MODEL_URL, id: process.env.E2E_MODEL_ID || 'gemma-4-26b', requests: () => 0, close() { /* The caller owns the external server. */ } };
  let requests = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-1', object: 'model' }] }));
        return;
      }
      if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      requests++;
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const asText = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part) => part.text ?? '').join('');
      const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'smoke-1' };
      // A background agent: the main agent spawns one when asked to, and says so once the spawn's result is back; the agent
      // itself (its system prompt starts with `pikit-agent:`) answers "Done." and is finished.
      const system = (body.messages ?? []).find((m) => m.role === 'system');
      const systemText = typeof system?.content === 'string' ? system.content : (system?.content ?? []).map((part) => part.text ?? '').join('');
      const isAgent = /^pikit-agent: /m.test(systemText);
      const spawnAsked = /spawn a background agent/i.test(asText) && !isAgent;
      // The spawn's result: pi hands the tool's answer back as a `tool` message; a refusal (the folder is not trusted, agents are off) is text without the agent's summary.
      const toolMessage = spawnAsked ? (body.messages ?? []).find((m) => m.role === 'tool') : undefined;
      const toolText = typeof toolMessage?.content === 'string' ? toolMessage.content : (toolMessage?.content ?? []).map((part) => part.text ?? '').join('');
      const spawned = !!toolMessage && /"agentId"/.test(toolText);
      const spawnFailed = !!toolMessage && !spawned;
      if (spawnAsked && !toolMessage) {
        const call = { index: 0, id: 'call_smoke_1', type: 'function', function: { name: 'agent_spawn', arguments: JSON.stringify({ name: 'smoke', role: 'says done', permission: 'read-only', brief: 'Reply with the word done and finish.' }) } };
        const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] }, finish_reason: 'tool_calls' }], usage }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        send({ ...base, choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      const reply = isAgent ? 'done' : spawned ? 'Started the smoke agent.' : spawnFailed ? `The spawn failed: ${toolText}` : `ok ${asText}`;
      const usage = { prompt_tokens: 12, completion_tokens: reply.split(' ').length, total_tokens: 12 + reply.split(' ').length };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (const word of reply.split(/(?<= )/)) send({ ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ ...base, choices: [], usage });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { external: false, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, id: 'smoke-1', requests: () => requests, close: () => server.close() };
}

// ------------------------------------------------------------------------------------------------------------------ the run

/** One AG-UI run over SSE (the renderer's own call): resolves with the assistant's text and whether the run finished. */
async function runPrompt(url, authed, threadId, content) {
  const res = await fetch(`${url}/api/copilotkit/agent/pi/run`, {
    method: 'POST',
    headers: { ...authed, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, tools: [], context: [], messages: [{ id: crypto.randomUUID(), role: 'user', content }], forwardedProps: {} }),
    signal: AbortSignal.timeout(Math.max(TIMEOUT_MS, 60_000)),
  });
  if (!res.ok) throw new Error(`POST /api/copilotkit/agent/pi/run answered ${res.status}: ${await res.text()}`);
  const out = { text: '', finished: false, error: undefined, events: 0 };
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      out.events++;
      if (event.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') out.text += event.delta;
      else if (event.type === 'RUN_FINISHED') out.finished = true;
      else if (event.type === 'RUN_ERROR') out.error = event.message ?? JSON.stringify(event);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ helpers

/** Prints `ok <what>`; throws "what did not hold" with the actual value otherwise. */
function check(condition, what, actual = '') {
  if (!condition) throw new Error(`ASSERTION FAILED: ${what}${actual === '' ? '' : ` (got: ${actual})`}`);
  log(`  ok  ${what}`);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The tail of the app's own logs and output, for a failure. */
function diagnostics(world, output) {
  const parts = [`--- app output (tail)\n${output.trim() || '(none)'}`];
  const logs = join(world.data, 'logs');
  if (existsSync(logs)) {
    for (const name of readdirSync(logs)) parts.push(`--- ${name} (tail)\n${readFileSync(join(logs, name), 'utf8').split('\n').slice(-25).join('\n')}`);
  }
  return parts.join('\n');
}

const started = Date.now();
try {
  await main();
} catch (error) {
  failed = error;
}
for (const cleanup of cleanups.reverse()) {
  try {
    cleanup();
  } catch {
    // best effort
  }
}
log('--- timings');
for (const [label, ms] of Object.entries(timings)) log(`  ${label.padEnd(18)} ${(ms / 1000).toFixed(2)} s`);
log(`  ${'total'.padEnd(18)} ${((Date.now() - started) / 1000).toFixed(2)} s`);
if (failed) {
  console.error(`\nSMOKE FAILED: ${failed.message}`);
  process.exit(1);
}
log('SMOKE OK');
