// Prepare a disposable native-macOS test profile, never the normal Pi or pi-kit profile.
// This copies the shipped CLI unchanged; an external host wrapper ONLY sets test environment paths.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = join(homedir(), 'Library', 'Caches', 'pi-kit-macos-service-test-9ef77b2');
const run = '/tmp/pi-kit-macos-service-test';
const app = join(repo, 'dist', 'release', 'mac-arm64', 'pi-kit.app');
const binary = join(app, 'Contents', 'MacOS', 'pi-kit');
const backend = join(app, 'Contents', 'Resources', 'backend');
const dataDir = join(root, 'data');
const home = join(root, 'home');
const agentDir = join(home, '.pi', 'agent');
const project = join(home, 'project');
const runtime = join(root, 'runtime');
assert.ok(existsSync(binary), 'Build the native mac-arm64 app first.');
const discoveryFile = join(dataDir, 'service.json');
if (existsSync(discoveryFile)) {
  const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8'));
  let alive = false;
  try {
    process.kill(discovery.pid, 0);
    alive = true;
  } catch {
    // A stale discovery file does not prevent preparing the test profile again.
  }
  assert.equal(alive, false, 'Stop the isolated test service before changing its runtime files.');
}
for (const path of [run, dataDir, home, agentDir, project, join(runtime, 'backend')])
  mkdirSync(path, { recursive: true, mode: 0o700 });
copyFileSync(join(backend, 'pi-kit.cjs'), join(runtime, 'backend', 'pi-kit.cjs'));
const asar = join(runtime, 'app.asar');
if (!existsSync(asar)) symlinkSync(join(app, 'Contents', 'Resources', 'app.asar'), asar);
writeFileSync(
  join(runtime, 'backend', 'service-host.cjs'),
  `// Test isolation only. The real packaged host is unmodified.\nprocess.env.HOME=${JSON.stringify(home)};\nprocess.env.PI_CODING_AGENT_DIR=${JSON.stringify(agentDir)};\nprocess.env.PI_KIT_CWD=${JSON.stringify(project)};\nrequire(${JSON.stringify(join(backend, 'service-host.cjs'))});\n`,
  { mode: 0o600 },
);

const keyFile = '/tmp/pi-kit-headless-test/llama-api-key';
const modelConfigured = existsSync(keyFile);
if (modelConfigured) {
  const key = readFileSync(keyFile, 'utf8').trim();
  const modelFile = join(agentDir, 'models.json');
  const models = existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : {};
  models.providers ??= {};
  models.providers['local-gemma4'] = {
    name: 'Local Gemma 4 E2B test',
    baseUrl: 'http://127.0.0.1:18088/v1',
    api: 'openai-completions',
    apiKey: key,
    models: [
      {
        id: 'gemma-4-e2b-local',
        name: 'Gemma 4 E2B Q4_0 (Mac llama.cpp)',
        reasoning: false,
        input: ['text'],
        contextWindow: 16384,
        maxTokens: 1024,
        samplingParams: { temperature: 0.2 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  writeFileSync(modelFile, JSON.stringify(models, null, 2) + '\n', { mode: 0o600 });
  chmodSync(modelFile, 0o600);
  const settingsFile = join(agentDir, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  Object.assign(settings, {
    defaultProvider: 'local-gemma4',
    defaultModel: 'gemma-4-e2b-local',
    defaultThinkingLevel: 'off',
    compaction: { reserveTokens: 2048, keepRecentTokens: 4096 },
  });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  chmodSync(settingsFile, 0o600);
}
const fixture = join(project, 'model-input.json');
if (!existsSync(fixture))
  writeFileSync(
    fixture,
    JSON.stringify({ numbers: [13, 19, 7], proof: randomBytes(8).toString('hex') }, null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const launcher = join(run, 'pi-kit');
writeFileSync(
  launcher,
  `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport PI_KIT_DATA_DIR=${quote(dataDir)}\nexport PI_KIT_LOG_DIR=${quote(join(dataDir, 'logs'))}\nexec ${quote(binary)} ${quote(join(runtime, 'backend', 'pi-kit.cjs'))} "$@"\n`,
  { mode: 0o755 },
);
chmodSync(launcher, 0o755);
const name = 'dev.pi-kit.app.service.' + createHash('sha256').update(dataDir).digest('hex').slice(0, 8);
const paths = {
  root,
  app,
  binary,
  backend,
  dataDir,
  home,
  agentDir,
  project,
  runtime,
  launcher,
  name,
  uid: process.getuid(),
};
writeFileSync(join(run, 'paths.json'), JSON.stringify(paths, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ profile: root, service: name, agentDir, project, launcher, modelConfigured }));
