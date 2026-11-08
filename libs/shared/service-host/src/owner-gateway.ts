import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { Http, RateLimit } from './remote-gateway-http';
import { type Backend, BackendProxy } from './remote-gateway-proxy';
import { RendererFiles } from './remote-gateway-static';

/** The installed profile's owner port; another profile, or a taken port, gets a free one that it keeps. */
export const OWNER_PORT = 47800;
const LINK_MS = 120_000;
const MAX_LINKS = 5;
const MAX_SESSIONS = 20;
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

interface OwnerSession {
  id: string;
  tokenHash: string;
  createdAt: number;
}
interface OwnerState {
  port?: number;
  sessions: OwnerSession[];
}

const isSession = (value: unknown): value is OwnerSession => {
  const session = value as Partial<OwnerSession> | null;
  return (
    !!session &&
    typeof session.id === 'string' &&
    typeof session.tokenHash === 'string' &&
    /^[a-f0-9]{64}$/.test(session.tokenHash) &&
    typeof session.createdAt === 'number'
  );
};

/** `<dataDir>/owner.json`, owner-only: the owner listener's port and the hashes of its signed-in browsers' tokens. */
export class OwnerStateFile {
  constructor(private readonly path: string) {}

  /** An unreadable file signs every browser out rather than failing the host. */
  async load(): Promise<OwnerState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<OwnerState>;
      const port =
        typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port < 65536
          ? value.port
          : undefined;
      const sessions = Array.isArray(value.sessions) ? value.sessions.filter(isSession) : [];
      return { ...(port ? { port } : {}), sessions };
    } catch {
      return { sessions: [] };
    }
  }

  async save(state: OwnerState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

/** What the host and the `pi-kit` command need of the owner listener. */
export interface OwnerAccess {
  listen(): Promise<void>;
  link(): { url: string; expiresAt: number };
  revokeAll(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The owner's door for a browser on this machine or behind an SSH forward: the whole app and every backend route,
 * never published. A one-time link signs a browser in; it then holds a bearer token in its own origin's storage, which
 * unlike a cookie is not shared with other ports on 127.0.0.1.
 */
export class OwnerGateway implements OwnerAccess {
  private server?: Server;
  private port = 0;
  private sessions: OwnerSession[] = [];
  private readonly links = new Map<string, number>();
  private readonly attempts = new RateLimit(20);
  private readonly streams = new Set<() => void>();
  private readonly proxy: BackendProxy;
  private readonly files: RendererFiles;

  constructor(
    private readonly options: {
      rendererRoot: string;
      backend: () => Backend | undefined;
      state: OwnerStateFile;
      preferredPort: number;
    },
  ) {
    this.proxy = new BackendProxy(options.backend);
    this.files = new RendererFiles(options.rendererRoot);
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error('Owner listener already open');
    await this.files.verify();
    const state = await this.options.state.load();
    this.sessions = state.sessions;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) Http.json(res, 500, { error: 'Request failed' });
        else res.destroy();
      });
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    this.port = await bind(server, state.port ?? this.options.preferredPort);
    this.server = server;
    if (state.port !== this.port) await this.options.state.save({ port: this.port, sessions: this.sessions });
  }

  link(): { url: string; expiresAt: number } {
    if (!this.server) throw new Error('The owner listener is not open.');
    const now = Date.now();
    for (const [code, expiresAt] of this.links) if (expiresAt <= now) this.links.delete(code);
    for (const oldest of this.links.keys()) {
      if (this.links.size < MAX_LINKS) break;
      this.links.delete(oldest);
    }
    const code = Http.secret();
    const expiresAt = now + LINK_MS;
    this.links.set(code, expiresAt);
    return { url: `http://127.0.0.1:${this.port}/#owner=${code}`, expiresAt };
  }

  async revokeAll(): Promise<void> {
    this.sessions = [];
    for (const abort of this.streams) abort();
    await this.options.state.save({ port: this.port, sessions: [] });
  }

  async close(): Promise<void> {
    for (const abort of this.streams) abort();
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    Http.secure(res);
    const host = req.headers.host ?? '';
    // Only the loopback names: a DNS-rebound name in Host is refused.
    if (
      ![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(host) ||
      !LOOPBACK.includes(req.socket.remoteAddress ?? '')
    )
      return Http.json(res, 403, { error: 'Invalid host' });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return Http.json(res, 403, { error: 'Invalid origin' });
    const method = req.method ?? '';
    const read = method === 'GET' || method === 'HEAD';
    if (!read && origin === undefined) return Http.json(res, 403, { error: 'Origin required' });
    const path = Http.path(req.url ?? '', ['/api/']);
    if (path === undefined) return Http.json(res, 400, { error: 'Invalid path' });
    if (path === '/owner/session' && method === 'POST') return this.signIn(req, res);
    if (path === '/api' || path.startsWith('/api/')) {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      const hash = token && Http.hash(token);
      if (!hash || !this.sessions.some((session) => session.tokenHash === hash)) {
        // Tells the page this listener refused it, not a backend or peer behind it.
        res.setHeader('WWW-Authenticate', 'Bearer realm="pi-kit-owner"');
        return Http.json(res, 401, { error: 'Sign-in required' });
      }
      return this.proxy.forward(req, res, { streams: this.streams });
    }
    if (!read) return Http.json(res, 405, { error: 'Method not allowed' });
    if (path === '/owner') return signInPage(res, method === 'HEAD');
    if (path.startsWith('/owner/') || path.startsWith('/phone') || path.startsWith('/peer/'))
      return Http.json(res, 404, { error: 'Not found' });
    return this.files.serve(path, req, res, true, 'owner');
  }

  private async signIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.attempts.hit()) return Http.json(res, 429, { error: 'Try again later' });
    const body = await Http.readBody(req, 1024);
    if (!body) return Http.json(res, 413, { error: 'Request too large' });
    let code: unknown;
    try {
      code = (JSON.parse(body.toString()) as { code?: unknown }).code;
    } catch {
      /* invalid */
    }
    const expiresAt = typeof code === 'string' ? this.links.get(code) : undefined;
    if (typeof code !== 'string' || expiresAt === undefined || expiresAt <= Date.now())
      return Http.json(res, 400, { error: 'Invalid or expired link' });
    this.links.delete(code);
    const token = Http.secret();
    this.sessions = [...this.sessions, { id: randomUUID(), tokenHash: Http.hash(token), createdAt: Date.now() }].slice(
      -MAX_SESSIONS,
    );
    await this.options.state.save({ port: this.port, sessions: this.sessions });
    return Http.json(res, 200, { token });
  }
}

/** Listens on loopback at `port`, or on a free port when that one is taken (or 0). */
async function bind(server: Server, port: number): Promise<number> {
  const attempt = (at: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(at, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  try {
    await attempt(port);
  } catch (error) {
    if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    await attempt(0);
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owner listener address');
  return address.port;
}

function signInPage(res: ServerResponse, head: boolean): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    head
      ? undefined
      : '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>pi-kit</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem}' +
          'code{background:#8882;padding:.1em .3em;border-radius:4px}</style><h1>pi-kit</h1>' +
          '<p>This browser is not signed in. On this computer, run <code>pi-kit open</code>: it opens pi-kit here with a one-time link.</p>' +
          '<p>Over SSH, <code>pi-kit open</code> prints the link and the port to forward.</p></html>',
  );
}
