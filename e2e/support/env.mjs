// The scratch world the end-to-end tests run: a pi agent folder with the local model, a git project with the test
// extension, a data folder, and `pnpm run dev:web` started against them. Nothing outside the temp folder is touched; ~/.pi/agent is not read.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { writeReportingSession } from './demo-sessions.mjs';
import { writeGraphSession } from './graph-session.mjs';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RENDERER = `http://localhost:${process.env.PI_KIT_DEV_RENDERER_PORT ?? '4200'}`;
export const BACKEND = `http://127.0.0.1:${process.env.PI_KIT_DEV_BACKEND_PORT ?? '4300'}`;
/** The scratch worlds' models. `scripts/e2e.mjs` puts a proxy at E2E_MODEL_URL that answers every one of them with the one real local model. */
export const MODEL = { provider: 'llama-swap', id: 'gemma-4-26b', baseUrl: process.env.E2E_MODEL_URL ?? 'http://127.0.0.1:8080/v1' };
/** The second scoped model, the one ⌘⇧M switches to. */
export const ALT_MODEL = { id: 'llama3.2' };
/** The scoped model that thinks (effort levels apply). */
export const THINKING_MODEL = { id: 'qwen3.8-27b' };

/**
 * Creates the scratch folders and returns the environment of the backend.
 * `demo: true` (the screenshots) adds what the screenshot scenes need: the A2UI and MCP App examples, a project skill, and two threads
 * written by hand (one with thinking and tool activity, one with forks and a compaction). `trusted: false` leaves the folder without an answer so
 * the trust dialog appears.
 * `fresh: true` is a machine that never ran pi: an empty agent folder, so the first-run flow has something to do (models.json, settings.json and auth.json are not written).
 * `onboarding: true` lets that flow open by itself (`PI_KIT_SKIP_ONBOARDING` is set otherwise, so it does not cover the windows the other tests drive); `offline: true` sets `PI_OFFLINE`
 * (a key is "not checked" instead of asked about at the provider).
 * `setup({ base, agent, project, data })` runs once the folders exist (a scene set writes the files it needs: credentials, a models.json), and `extraEnv({ base, agent, project, data })` adds to the backend's environment.
 */
export function createWorld({ demo = false, trusted = true, versionCheck = false, fresh = false, onboarding = false, offline = false, setup, extraEnv } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-kit-e2e-')));
  const agent = join(base, 'agent');
  const project = join(base, 'project');
  const data = join(base, 'data');
  mkdirSync(agent, { recursive: true });
  if (!fresh) {
    // Keep the three distinct picker fixtures even when inference uses an explicitly selected llama-swap model.
    const models = [
      { id: 'gemma-4-26b', name: 'Gemma 4 26B-A4B', contextWindow: 262144 },
      { id: ALT_MODEL.id, name: 'Llama 3.2 3B', contextWindow: 131072 },
      { id: THINKING_MODEL.id, name: 'Qwen3.8 27B', reasoning: true, contextWindow: 262144 },
    ];
    writeFileSync(
      join(agent, 'models.json'),
      JSON.stringify(
        {
          providers: {
            [MODEL.provider]: {
              baseUrl: MODEL.baseUrl,
              api: 'openai-completions',
              apiKey: 'llama-swap',
              models,
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(agent, 'settings.json'),
      JSON.stringify(
        {
          defaultProvider: MODEL.provider,
          defaultModel: MODEL.id,
          defaultThinkingLevel: 'off',
          enabledModels: [`${MODEL.provider}/${MODEL.id}`, `${MODEL.provider}/${ALT_MODEL.id}`],
          lastChangelogVersion: '1.2.0',
        },
        null,
        2,
      ),
    );
    // As pi creates it: readable by the user only (the API-key test checks the mode after pi wrote a key into it).
    writeFileSync(join(agent, 'auth.json'), '{}', { mode: 0o600 });
  }
  cpSync(join(root, 'e2e', 'fixtures', 'project'), project, { recursive: true });
  // The human-in-the-loop test extension: it lives with the support code and is installed into every scratch project.
  cpSync(join(root, 'e2e', 'support', 'pk-hitl.ts'), join(project, '.pi', 'extensions', 'pk-hitl.ts'));
  // Turns an extension starts in an idle thread: e2e/bg-agents.e2e.mjs checks that the open transcript shows them live.
  cpSync(join(root, 'e2e', 'support', 'pk-bg-turn.ts'), join(project, '.pi', 'extensions', 'pk-bg-turn.ts'));
  // The A2UI example: its tool answers with a surface, which e2e/a-genui.e2e.mjs looks at.
  cpSync(join(root, 'examples', 'a2ui-failing-specs'), join(project, '.pi', 'extensions', 'a2ui-failing-specs'), { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'fixture');
  if (demo) {
    mkdirSync(join(project, '.pi', 'skills', 'pdf-tools'), { recursive: true });
    writeFileSync(join(project, '.pi', 'skills', 'pdf-tools', 'SKILL.md'), '---\nname: pdf-tools\ndescription: Read, merge and split PDF files\n---\n\nUse the pdf CLI to work with PDF files.\n');
    cpSync(join(root, 'examples', 'a2ui-failing-specs'), join(project, '.pi', 'extensions', 'a2ui-failing-specs'), { recursive: true });
    writeFileSync(
      join(project, '.pi', 'mcp.json'),
      JSON.stringify({ mcpServers: { issues: { command: 'node', args: [join(root, 'examples', 'mcp-app-server', 'server.mjs')], exposure: 'direct', description: 'A toy issue tracker with a create-issue form' } } }, null, 2),
    );
    git('add', '-A');
    git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'demo resources');
    writeReportingSession({ agentDir: agent, cwd: project });
    writeGraphSession({ agentDir: agent, cwd: project });
    spawnSync('node', [join(root, 'scripts', 'gen-big-session.mjs'), '--agent-dir', agent, '--cwd', project, '--turns', '14', '--fork-every', '5', '--forks', '2', '--name', 'Tree demo'], { cwd: root, stdio: 'ignore' });
  }
  setup?.({ base, agent, project, data });
  const token = 'e2e-token-e2e-token-e2e-token-1234';
  const env = {
    PI_CODING_AGENT_DIR: agent,
    PI_KIT_CWD: project,
    ...(trusted ? { PI_KIT_TRUSTED_CWDS: project } : {}),
    PI_KIT_DATA_DIR: data,
    // Where the test extension writes what pi's side was given by each dialog (e2e/support/pk-hitl.ts).
    PK_HITL_LOG: join(base, 'hitl.log'),
    PI_KIT_TOKEN: token,
    // Every world has a credential store of its own, a scratch file: the tests never touch the operating system's keychain. A scene set or test can name another (`extraEnv`).
    PI_KIT_SECRET_STORE: `file:${join(base, 'secrets.json')}`,
    // Thread worktrees go inside the scratch world, never into ~/.pi-kit/worktrees; the GitHub CLI is off so no test can open a pull request.
    PI_KIT_WORKTREE_ROOT: join(base, 'worktrees'),
    PI_KIT_GH: 'none',
    // The first-run flow would cover every window the other tests drive; the tests that look at it ask for it (`onboarding: true`).
    ...(onboarding ? {} : { PI_KIT_SKIP_ONBOARDING: '1' }),
    ...(offline ? { PI_OFFLINE: '1' } : {}),
    // The first-run flow looks for local servers on their usual ports; the tests' model may sit elsewhere (`E2E_MODEL_URL`).
    ...(fresh ? { PI_KIT_LOCAL_PROBES: MODEL.baseUrl } : {}),
    // Tests write session files behind the app's back; the default 30 s pass would make them wait for it.
    PI_KIT_RECONCILE_MS: '3000',
    // The update tests end the backend with "Restart to use ..."; dev:web has no watchdog, the test starts it again by hand.
    PI_KIT_ALLOW_RESTART: '1',
    PI_KIT_UPDATE_WATCH_MS: '1000',
    // The version check is a call to pi.dev; the tests look at the line it produces, not at the network (the screenshots do call it).
    ...(versionCheck ? {} : { PI_SKIP_VERSION_CHECK: '1' }),
    ...voiceEnv(),
    ...(extraEnv ? extraEnv({ base, agent, project, data }) : {}),
  };
  return { base, agent, project, data, env, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

async function until(label, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const isUp = async (url, headers) => {
  try {
    return (await fetch(url, { headers })).ok;
  } catch {
    return false;
  }
};

/** Starts `pnpm run dev:web` (scripts/dev.mjs web) with the world's environment and waits until the backend and the renderer answer. */
export async function startDevWeb(world, { log } = {}) {
  if (!world.env.PI_KIT_SECRET_STORE) throw new Error('A world needs a scratch PI_KIT_SECRET_STORE: the backend would use the real keychain.');
  if ((await isUp(`${BACKEND}/api/dev/token`, { Origin: RENDERER })) || (await isUp(RENDERER))) {
    throw new Error(`The renderer or backend port (4200 / 4300 unless PI_KIT_DEV_RENDERER_PORT / PI_KIT_DEV_BACKEND_PORT say otherwise) is in use already. Stop the running dev:web first; the tests start their own with a scratch pi folder and project.`);
  }
  const child = spawn('node', ['scripts/dev.mjs', 'web'], { cwd: root, env: { ...process.env, ...world.env }, stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'], detached: true });
  await until('the backend', () => isUp(`${BACKEND}/api/dev/token`, { Origin: RENDERER }));
  await until('the renderer', () => isUp(RENDERER));
  return {
    child,
    stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    },
  };
}

/**
 * A world's backend alone, from the built `dist/apps/backend` (the sharded runner builds it once and serves one renderer for every shard):
 * the environment `scripts/dev.mjs web` gives it, on BACKEND's port.
 */
export async function startBackend(world, { log } = {}) {
  if (!world.env.PI_KIT_SECRET_STORE) throw new Error('A world needs a scratch PI_KIT_SECRET_STORE: the backend would use the real keychain.');
  if (await isUp(`${BACKEND}/api/dev/token`, { Origin: RENDERER })) throw new Error(`The backend port of ${BACKEND} is in use already.`);
  const child = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...world.env,
      NODE_ENV: 'development',
      PI_KIT_VERSION: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      PI_KIT_PORT: new URL(BACKEND).port,
      PI_KIT_ORIGIN: RENDERER,
    },
    stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
    detached: true,
  });
  await until('the backend', () => isUp(`${BACKEND}/api/dev/token`, { Origin: RENDERER }));
  return {
    child,
    stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    },
  };
}

/**
 * Voice input without a model or a network: the backend uses the test engine, and "Download Whistle" fetches a few-byte fixture from the
 * repository (a `file:` URL, honoured only outside production) and checks it against the fixture's own SHA-256, so the whole consent and download flow
 * runs for real and nothing leaves the machine.
 */
export function voiceEnv() {
  const fixture = join(root, 'e2e', 'fixtures', 'voice', 'fake-whistle.cact');
  const bytes = readFileSync(fixture);
  return {
    PI_KIT_TRANSCRIBE_ENGINE: 'fake',
    PI_KIT_WHISTLE_URL: pathToFileURL(fixture).href,
    PI_KIT_WHISTLE_SHA256: createHash('sha256').update(bytes).digest('hex'),
    PI_KIT_WHISTLE_BYTES: String(bytes.length),
  };
}
