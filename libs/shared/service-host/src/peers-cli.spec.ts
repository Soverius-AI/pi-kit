import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpcPeer } from './host-channel';
import { instanceKeyFile } from './instance-key-sealing';
import { type CliContext, runCli } from './service-cli';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const TOKEN = 'b'.repeat(32);
const pairId = randomUUID();
const manager = {
  self: { instanceId: randomUUID(), name: 'server', protocolVersion: 1 },
  keyInitialized: true,
  peers: [],
  requests: [
    {
      pairId,
      name: 'laptop',
      origin: 'https://laptop.tail0.ts.net',
      fingerprint: 'f'.repeat(43),
      confirmationCode: '123456',
      expiresAt: Date.now() + 300_000,
    },
  ],
};

/** The backend's peer routes as the CLI reaches them: what it was asked, and a manager or an error back. */
async function backend(answer: (method: string, path: string) => { status: number; body: unknown }) {
  const asked: Array<{ method?: string; path?: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    asked.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const { status, body } = answer(req.method ?? '', req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = { call: async () => ({ url, port: 0, token: TOKEN }), close: () => undefined } as unknown as RpcPeer;
  return { asked, host };
}

function context(host: RpcPeer | undefined, dataDir = tmpdir()): CliContext {
  return {
    version: '0.0.0',
    serviceName: 'test',
    dataDir,
    logDir: tmpdir(),
    manager: undefined,
    discover: () =>
      host ? { pid: 1, version: '0.0.0', level: 'login', socket: 's', token: 't', startedAt: 'now' } : undefined,
    connect: async () => host as RpcPeer,
    tail: () => undefined,
    sleep: async () => undefined,
  };
}

function terminal(input?: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (text: string) => void out.push(text),
      err: (text: string) => void err.push(text),
      readLine: async () => input,
    },
  };
}

describe('pi-kit peers', () => {
  it('pairs through the backend’s peer routes with the host’s token, taking the invitation from stdin', async () => {
    const { asked, host } = await backend((method) => ({
      status: method === 'DELETE' ? 400 : 200,
      body: method === 'DELETE' ? { message: 'No such request.' } : manager,
    }));
    const ctx = context(host);

    const connect = terminal('pi-kit-invitation-secret');
    expect(await runCli(['peers', 'connect'], connect.io, ctx)).toBe(0);
    expect(connect.out.join('')).toContain('code 123456');

    const approve = terminal();
    expect(await runCli(['peers', 'approve', pairId, '--allow-relay'], approve.io, ctx)).toBe(0);

    const reject = terminal();
    expect(await runCli(['peers', 'reject', pairId], reject.io, ctx)).toBe(1);
    expect(reject.err.join('')).toContain('No such request.');

    expect(asked).toEqual([
      {
        method: 'POST',
        path: '/api/instances/connect',
        authorization: `Bearer ${TOKEN}`,
        body: { invitation: 'pi-kit-invitation-secret', allowRelay: false },
      },
      {
        method: 'POST',
        path: `/api/instances/requests/${pairId}/approve`,
        authorization: `Bearer ${TOKEN}`,
        body: { allowRelay: true },
      },
      {
        method: 'DELETE',
        path: `/api/instances/requests/${pairId}`,
        authorization: `Bearer ${TOKEN}`,
        body: undefined,
      },
    ]);
  });

  it('turns the owner-only key file on only with explicit consent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-kit-peers-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const ctx = context(undefined, join(dir, 'pi-kit'));

    expect(await runCli(['peers', 'key-file'], terminal().io, ctx)).toBe(2);
    await expect(stat(instanceKeyFile(ctx.dataDir))).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await runCli(['peers', 'key-file', '--yes'], terminal().io, ctx)).toBe(0);
    if (process.platform !== 'win32') expect((await stat(instanceKeyFile(ctx.dataDir))).mode & 0o777).toBe(0o600);
  });
});
