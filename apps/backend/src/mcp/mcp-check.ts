import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { McpCheckResult } from '@pi-kit/protocol';

/**
 * The reachability check of the "Add a server" wizard: does the thing answer, before it is written into `mcp.json` and connected. It is deliberately small. A URL
 * gets the first two calls of an MCP session over Streamable HTTP (`initialize`, then `tools/list`), enough to say "answered in 180 ms, 3 tools: search, open, list"; the
 * sign-in of an OAuth server is not attempted (a 401 is the expected answer and is reported as such), and pi, not this module, is the judge of what really connects. A command
 * is looked up on the PATH and never run: starting an unknown program is what "Add and connect" does, after the person has seen it.
 */

const TIMEOUT_MS = 8000;
const PROTOCOL = '2025-03-26';

type Fetch = typeof fetch;

interface RpcAnswer {
  status: number;
  session?: string;
  json?: unknown;
}

/** One JSON-RPC call; the answer is JSON, or a server-sent event stream whose first `data:` line is the answer. */
async function rpc(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<RpcAnswer> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body), signal });
  const session = res.headers.get('mcp-session-id') ?? undefined;
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, ...(session ? { session } : {}) };
  }
  const type = res.headers.get('content-type') ?? '';
  const text = await readSome(res, type.includes('event-stream'));
  let json: unknown;
  try {
    json = JSON.parse(type.includes('event-stream') ? (/^data:\s*(.+)$/m.exec(text)?.[1] ?? '') : text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ...(session ? { session } : {}), json };
}

/** The body of a response, or for an event stream the first event only (the stream may never end). */
async function readSome(res: Response, stream: boolean): Promise<string> {
  if (!stream || !res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/\n\n/.test(text) || /^data:.*\n/m.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Asks the server at `url` whether it is an MCP server and what tools it offers. A token is sent as `Authorization: Bearer`, for this request only. */
export async function checkUrl(url: string, token?: string, fetchImpl: Fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<McpCheckResult> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const init = await rpc(fetchImpl, url, auth, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'pi-kit', version: '1' } } }, ctl.signal);
    const ms = Date.now() - started;
    if (init.status === 401 || init.status === 403) {
      return token
        ? { ok: false, status: 'refused', message: `The server answered ${init.status}: it refused this token.`, ms }
        : { ok: true, status: 'needs-sign-in', message: `The server answered ${init.status} in ${ms} ms: it asks for a sign-in, which starts once it is added.`, ms };
    }
    if (init.status < 200 || init.status >= 300) return { ok: false, status: 'unreachable', message: `The server answered ${init.status}${init.status === 404 || init.status === 405 ? ': this address does not look like an MCP endpoint' : ''}.`, ms };
    if (!isRecord(init.json) || !isRecord(init.json['result'])) return { ok: false, status: 'unreachable', message: 'The address answered, but not as an MCP server does.', ms };
    // The tool list is a bonus: a server that will not list yet still answered.
    let tools: string[] | undefined;
    try {
      const headers = { ...auth, ...(init.session ? { 'Mcp-Session-Id': init.session } : {}) };
      await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: ctl.signal }).then((r) => r.body?.cancel());
      const listed = await rpc(fetchImpl, url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctl.signal);
      const result = isRecord(listed.json) && isRecord(listed.json['result']) ? listed.json['result']['tools'] : undefined;
      if (Array.isArray(result)) tools = result.flatMap((t) => (isRecord(t) && typeof t['name'] === 'string' ? [t['name']] : []));
      if (init.session) await fetchImpl(url, { method: 'DELETE', headers, signal: ctl.signal }).then((r) => r.body?.cancel()).catch(() => undefined);
    } catch {
      tools = undefined;
    }
    const shown = tools ? `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}${tools.length > 0 ? `: ${tools.slice(0, 4).join(', ')}${tools.length > 4 ? ', …' : ''}` : ''}` : undefined;
    return { ok: true, status: 'reachable', message: `Answered in ${ms} ms${shown ? ` · ${shown}` : ''}.`, ms, ...(tools ? { tools } : {}) };
  } catch (error) {
    const ms = Date.now() - started;
    if (ctl.signal.aborted) return { ok: false, status: 'unreachable', message: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`, ms };
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    return { ok: false, status: 'unreachable', message: `Could not reach it: ${cause}.`, ms };
  } finally {
    clearTimeout(timer);
  }
}

const executable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether the first word of a command line is a program on the PATH (or a path to one). The program is not started. */
export function checkCommand(program: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): McpCheckResult {
  if (program.includes('/') || isAbsolute(program)) {
    const path = resolve(cwd, program);
    return executable(path) ? { ok: true, status: 'found', message: `${path} exists. It is started when the server connects.` } : { ok: false, status: 'missing', message: `${path} is not an executable file.` };
  }
  const extensions = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const path = join(dir, program + ext);
      if (executable(path)) return { ok: true, status: 'found', message: `${program} is at ${path}. It is started when the server connects.` };
    }
  }
  return { ok: false, status: 'missing', message: `${program} is not on the PATH of pi-kit’s backend.` };
}
