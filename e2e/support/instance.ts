import { spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { InstanceKeyEncryption, InstanceKeyStore } from '../../apps/desktop/src/instance-key';
import { InstanceKeyRequestSchema } from '../../libs/shared/protocol/src/peers';

/** Test-only OS sealing: real encrypted identity files and proofs without touching the user's keychain. */
export function fixtureEncryption(key: () => Buffer): InstanceKeyEncryption {
  return {
    available: async () => true,
    encrypt: async (text) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key(), iv);
      const data = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt: async (data) => {
      const cipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
    },
  };
}

/** A promise that settles within `ms`; a hung Electron or network call never stalls a probe. */
export async function bounded<T>(work: Promise<T>, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe step timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function until(check: () => Promise<boolean>, label: string, ms = 30000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await bounded(check(), Math.max(1, end - Date.now()))) return;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface BackendOptions {
  root: string;
  directory: string;
  label?: string;
  port?: number;
  token?: string;
  args?: string[];
  env?: Record<string, string>;
  keys?: () => InstanceKeyStore;
}

export interface Backend {
  child: ChildProcess;
  url: string;
  token: string;
  project: string;
  log(): string;
  owner(path: string, method?: string, body?: unknown): Promise<any>;
  stop(): Promise<void>;
}

/** An isolated backend under its own data, home and agent directories; never a normal profile. */
export async function startBackend(options: BackendOptions): Promise<Backend> {
  const { root, directory } = options;
  for (const dir of ['project', 'home', 'agent']) await mkdir(join(directory, dir), { recursive: true });
  const project = await realpath(join(directory, 'project'));
  if (options.label)
    await writeFile(
      join(project, 'README.md'),
      `# ${options.label}\n\nIsolated fixture project of instance ${options.label}.\n`,
    );
  const port = options.port ?? (await freePort()),
    token = options.token ?? randomBytes(32).toString('hex'),
    url = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(process.execPath, [...(options.args ?? []), join(root, 'dist/apps/backend/main.js')], {
    env: {
      PATH: process.env['PATH'],
      HOME: join(directory, 'home'),
      TMPDIR: directory,
      LANG: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PI_KIT_PARENT_PID: String(process.pid),
      PI_CODING_AGENT_DIR: join(directory, 'agent'),
      PI_KIT_CWD: project,
      PI_KIT_TRUSTED_CWDS: project,
      PI_KIT_DATA_DIR: join(directory, 'data'),
      PI_KIT_PORT: String(port),
      PI_KIT_TOKEN: token,
      PI_KIT_ORIGIN: '',
      PI_KIT_SECRET_STORE: `file:${join(directory, 'secrets.json')}`,
      PI_KIT_SKIP_ONBOARDING: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_OFFLINE: '1',
      PI_KIT_GH: 'none',
      PI_KIT_WORKTREE_ROOT: join(directory, 'worktrees'),
      ...(options.keys ? { PI_KIT_DESKTOP: '1' } : {}),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (part) => (log = (log + String(part)).slice(-50000)));
  child.stderr?.on('data', (part) => (log = (log + String(part)).slice(-50000)));
  if (options.keys)
    child.on('message', (message: any) => {
      if (message?.type !== 'instance-key') return;
      const reply = (body: object) => {
        if (child.connected) child.send({ type: 'desktop-answer', id: message.id, ...body });
      };
      const parsed = InstanceKeyRequestSchema.safeParse(message.keyRequest);
      if (!parsed.success) {
        reply({ error: 'Invalid fixture request' });
        return;
      }
      const keys = options.keys!(),
        value = parsed.data;
      void (
        value.action === 'info' ? keys.info(value.instanceId, value.create) : keys.sign(value.instanceId, value.claims)
      ).then(
        (result) => reply({ result }),
        () => reply({ error: 'Fixture key unavailable', errorCode: 'unavailable' }),
      );
    });
  const owner = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${options.label ?? 'backend'} ${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve(undefined);
        }, 4000),
      ),
    ]);
  };
  try {
    await until(
      async () => (await fetch(url + '/api/health', { headers: { authorization: `Bearer ${token}` } })).ok,
      `${options.label ?? 'backend'} backend`,
    );
  } catch (error) {
    await stop();
    throw new Error(String(error) + '\n' + log.replaceAll(token, '<token>'), { cause: error });
  }
  return { child, url, token, project, log: () => log, owner, stop };
}
