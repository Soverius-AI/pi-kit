import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCommand, checkUrl } from './mcp-check';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake server: the answer for each JSON-RPC method (or a status for the whole call). */
function server(handlers: Record<string, (init: RequestInit) => Response>): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body)) as { method: string };
    const handler = handlers[body.method];
    return handler ? handler(init ?? {}) : new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
}

describe('the reachability check of a URL', () => {
  it('reports an MCP server that answers, with the time and its tools', async () => {
    const fetchImpl = server({
      initialize: () => json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'docs' } } }, 200, { 'mcp-session-id': 's1' }),
      'tools/list': () => json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }, { name: 'open' }, { name: 'list' }] } }),
    });
    const result = await checkUrl('https://docs.internal.example/mcp', undefined, fetchImpl);
    expect(result).toMatchObject({ ok: true, status: 'reachable', tools: ['search', 'open', 'list'] });
    expect(result.message).toMatch(/^Answered in \d+ ms · 3 tools: search, open, list\.$/);
  });

  it('reads an answer that comes as a server-sent event', async () => {
    const sse = (body: unknown) => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const fetchImpl = server({ initialize: () => sse({ jsonrpc: '2.0', id: 1, result: {} }), 'tools/list': () => sse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }] } }) });
    expect(await checkUrl('https://x.example/mcp', undefined, fetchImpl)).toMatchObject({ ok: true, tools: ['a'] });
  });

  it('is still reachable when the tool list does not come', async () => {
    const fetchImpl = server({ initialize: () => json({ jsonrpc: '2.0', id: 1, result: {} }), 'tools/list': () => new Response('nope', { status: 500 }) });
    const result = await checkUrl('https://x.example/mcp', undefined, fetchImpl);
    expect(result).toMatchObject({ ok: true, status: 'reachable' });
    expect(result.tools).toBeUndefined();
  });

  it('takes a 401 without a token as an OAuth server asking for its sign-in, and a refused token as a refusal', async () => {
    const fetchImpl = server({ initialize: () => new Response('no', { status: 401 }) });
    expect(await checkUrl('https://x.example/mcp', undefined, fetchImpl)).toMatchObject({ ok: true, status: 'needs-sign-in' });
    expect(await checkUrl('https://x.example/mcp', 'tok', fetchImpl)).toMatchObject({ ok: false, status: 'refused' });
  });

  it('sends the token as a bearer header and nowhere else', async () => {
    const fetchImpl = server({ initialize: () => json({ jsonrpc: '2.0', id: 1, result: {} }) });
    const result = await checkUrl('https://x.example/mcp', 'sk-secret-123', fetchImpl);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.every(([, init]) => (init.headers as Record<string, string>)['Authorization'] === 'Bearer sk-secret-123')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-secret-123');
  });

  it('says so when the address is not an MCP endpoint, or does not answer', async () => {
    expect(await checkUrl('https://x.example/', undefined, server({ initialize: () => new Response('', { status: 404 }) }))).toMatchObject({ ok: false, status: 'unreachable', message: expect.stringContaining('404') });
    expect(await checkUrl('https://x.example/', undefined, server({ initialize: () => json({ hello: 'world' }) }))).toMatchObject({ ok: false, message: expect.stringContaining('not as an MCP server does') });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
    }) as unknown as typeof fetch;
    expect(await checkUrl('http://127.0.0.1:9/mcp', undefined, down)).toMatchObject({ ok: false, status: 'unreachable', message: expect.stringContaining('ECONNREFUSED') });
  });

  it('gives up after the time allowed', async () => {
    const hangs = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await checkUrl('https://x.example/mcp', undefined, hangs, 30)).toMatchObject({ ok: false, status: 'unreachable', message: expect.stringContaining('No answer') });
  });
});

describe('the check of a command', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds a program on the PATH without starting it', () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-check-'));
    const program = join(dir, 'my-mcp');
    writeFileSync(program, '#!/bin/sh\nexit 1\n');
    chmodSync(program, 0o755);
    expect(checkCommand('my-mcp', { PATH: `/nonexistent:${dir}` })).toMatchObject({ ok: true, status: 'found', message: expect.stringContaining(program) });
    expect(checkCommand('absent-program', { PATH: dir })).toMatchObject({ ok: false, status: 'missing' });
    expect(checkCommand(program, {})).toMatchObject({ ok: true });
    expect(checkCommand(join(dir, 'nothing'), {})).toMatchObject({ ok: false, status: 'missing' });
  });
});
