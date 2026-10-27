import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { proxyEnvironment } from './proxy-env';
import type { BackendHandle } from './watchdog';

/** Where the backend listens and the token it expects. Chosen once per app launch and kept across restarts. */
export interface BackendEndpoint {
  url: string;
  port: number;
  token: string;
}

export interface RunningBackend extends BackendEndpoint {
  child: ChildProcess;
  /** Resolves with the exit code if the backend dies, so callers can stop waiting for it. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): void;
}

/** Asks the OS for a free loopback port. The port is released before the backend binds it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A random loopback port and a random per-launch token. */
export async function allocateEndpoint(): Promise<BackendEndpoint> {
  const port = await freePort();
  return { port, url: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('hex') };
}

export interface SpawnOptions {
  entry: string;
  origin: string;
  dataDir: string;
  /** The folder pi works in for a thread that names none. */
  cwd: string;
  version: string;
  /** Extra environment (a fixed PATH from the login shell, ...). */
  env?: NodeJS.ProcessEnv;
  /** Receives what the backend prints; without it the output goes to this process's own stdout and stderr. */
  onOutput?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
}

/**
 * Starts the NestJS backend as a child process on 127.0.0.1 with the given port and token. The Electron
 * binary doubles as Node via ELECTRON_RUN_AS_NODE; packaged, `entry` is Resources/backend/main.js.
 */
export function spawnBackend(endpoint: BackendEndpoint, options: SpawnOptions): RunningBackend {
  const child = spawn(process.execPath, [options.entry], {
    cwd: join(options.entry, '..'),
    // The fourth channel is an IPC pipe: the backend asks the main process for things only Electron can do.
    stdio: ['ignore', options.onOutput ? 'pipe' : 'inherit', options.onOutput ? 'pipe' : 'inherit', 'ipc'],
    env: {
      ...process.env,
      ...options.env,
      // HTTPS_PROXY for the backend's own requests.
      ...proxyEnvironment({ ...process.env, ...options.env }),
      ELECTRON_RUN_AS_NODE: '1',
      PI_KIT_DESKTOP: '1',
      NODE_ENV: 'production',
      PI_KIT_PORT: String(endpoint.port),
      PI_KIT_TOKEN: endpoint.token,
      PI_KIT_ORIGIN: options.origin,
      // SQLite lives under Electron's userData folder.
      PI_KIT_DATA_DIR: options.dataDir,
      PI_KIT_PARENT_PID: String(process.pid),
      PI_KIT_VERSION: options.version,
      PI_KIT_CWD: options.cwd,
    },
  });
  if (options.onOutput) {
    child.stdout?.on('data', (chunk: Buffer) => options.onOutput?.(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => options.onOutput?.(chunk, 'stderr'));
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    // A process that cannot be started at all (a missing entry never gets here; a bad executable does) also counts as ended.
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return { ...endpoint, child, exited, stop: () => child.kill() };
}

/** What `GET /api/health` answers. */
export interface Health {
  status: string;
  bootId?: string;
}

/** One authenticated health request; `undefined` when the backend does not answer. */
export async function pingHealth(endpoint: BackendEndpoint, timeoutMs = 4000): Promise<Health | undefined> {
  try {
    const res = await fetch(`${endpoint.url}/api/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as Health) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Polls GET /api/health with the token until it answers 200, or rejects when the process dies or, with a finite `timeoutMs`, after it.
 * The app waits without a limit (`Infinity`): a slow machine, a long migration or a Keychain prompt must not have the backend killed under it.
 */
export async function waitForHealth(backend: RunningBackend, timeoutMs = Infinity): Promise<Health> {
  let died = false;
  void backend.exited.then(() => (died = true));
  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
  while (Date.now() < deadline) {
    if (died) throw new Error('The backend exited before it became healthy.');
    const health = await pingHealth(backend, 2000);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The backend did not become healthy within ${timeoutMs / 1000}s.`);
}

/** Adapts a spawned backend to the watchdog: launch resolves when healthy, and a failed start leaves no process behind. */
export async function launchForWatchdog(spawnIt: () => RunningBackend, healthTimeoutMs = Infinity): Promise<BackendHandle & { running: RunningBackend; health: Health }> {
  const running = spawnIt();
  try {
    const health = await waitForHealth(running, healthTimeoutMs);
    return { exited: running.exited, kill: () => running.stop(), running, health };
  } catch (error) {
    running.stop();
    throw error;
  }
}
