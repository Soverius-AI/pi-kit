import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiteLlmService } from '../setup/litellm.service';
import { PiPluginService } from './pi-plugin.service';
import { PiSessionService } from './pi-session.service';
import { TrustService } from './trust.service';

// Real SDK and stdio MCP server; no inference and no model response stubs.
vi.mock('./load-pi', () => ({
  loadPi: () => import('@earendil-works/pi-coding-agent'),
  loadPiMcp: () => import('@earendil-works/pi-mcp'),
}));

let base: string;
let agent: string;
/** A stdio MCP server of this spec's own (`FIXTURE_SERVER`), written per test next to the agent folder. */
let fixture: string;
let sessions: PiSessionService;
let id: string;
/** Whether `promise` settles before the next macrotask: an answer the session can give from what it knows waits for nothing but microtasks. */
const settlesNow = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]);

/**
 * A dependency-free stdio MCP server (newline-delimited JSON-RPC) with two modes, chosen by its first argument:
 * `paged` lists its tools in two pages and holds the second back until the gate file (second argument) exists;
 * `tools-only` declares the tools capability but no resources, and lists no tools.
 */
const FIXTURE_SERVER = [
  "import { existsSync } from 'node:fs';",
  "import { createInterface } from 'node:readline';",
  "import { setTimeout as sleep } from 'node:timers/promises';",
  'const [mode, gate] = process.argv.slice(2);',
  "const schema = { type: 'object', properties: {} };",
  "const tools = [{ name: 'first', description: 'On page one.', inputSchema: schema }, { name: 'second', description: 'On page two.', inputSchema: schema }];",
  "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
  "const refuse = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');",
  "createInterface({ input: process.stdin }).on('line', async (line) => {",
  '  if (!line.trim()) return;',
  '  const { id, method, params } = JSON.parse(line);',
  '  if (id === undefined) return;',
  '  switch (method) {',
  "    case 'initialize': return reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: mode, version: '1.0.0' } });",
  "    case 'ping': return reply(id, {});",
  "    case 'tools/list':",
  "      if (mode === 'tools-only') return reply(id, { tools: [] });",
  "      if (!params || !params.cursor) return reply(id, { tools: [tools[0]], nextCursor: 'page-2' });",
  '      while (!existsSync(gate)) await sleep(20);',
  '      return reply(id, { tools: [tools[1]] });',
  "    case 'tools/call':",
  "      if (!tools.some((tool) => tool.name === params.name)) return refuse(id, -32602, 'Unknown tool: ' + params.name);",
  "      return reply(id, { content: [{ type: 'text', text: params.name + ' ran.' }], structuredContent: { tool: params.name } });",
  "    default: return refuse(id, -32601, 'Method not found: ' + method);",
  '  }',
  '});',
  "process.stdin.on('end', () => process.exit(0));",
  '',
].join('\n');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pk-session-mcp-'));
  agent = join(base, 'agent');
  mkdirSync(agent);
  fixture = join(base, 'fixture-server.mjs');
  writeFileSync(fixture, FIXTURE_SERVER);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('PI_OFFLINE', '1');
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'unused', contextWindow: 8192 }],
  } } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'unused' }));
  sessions = new PiSessionService(new TrustService(), new PiPluginService(), { refreshCatalog: async () => undefined } as unknown as LiteLlmService);
  id = randomUUID();
});

afterEach(() => {
  sessions.onModuleDestroy();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it('calls MCP tools and resources over the session connection, retaining app metadata and command notifications', async () => {
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [new URL('../../../../examples/mcp-app-server/server.mjs', import.meta.url).pathname], exposure: 'direct',
  } } }));
  await sessions.open(id, { cwd: base });
  const result = await sessions.callMcpTool(id, 'fixture', 'create_issue', { title: 'Session bridge', team: 'Platform', priority: 'High' });
  expect(result).toMatchObject({ structuredContent: { id: 'ISSUE-1', title: 'Session bridge' } });
  // The tool list the tap saw proves a tool the server never offered missing at once; no deadline is involved.
  const missing = sessions.callMcpTool(id, 'fixture', 'close_issue', {});
  expect(await settlesNow(missing)).toBe(true);
  await expect(missing).rejects.toThrow('The MCP server "fixture" does not offer a tool "close_issue".');
  expect(sessions.mcpAppResource(id, 'fixture', 'open_issue_form')).toBe('ui://issues/create');
  const resource = await sessions.readMcpResource(id, 'fixture', 'ui://issues/create');
  expect(resource.contents[0]).toMatchObject({ uri: 'ui://issues/create', mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: {} } } });
  expect(resource.contents[0]['text']).toContain('<form id="form">');
  const status = await sessions.mcpCommand(id, '', { timeoutMs: 5000 });
  await status.done;
  expect(status.finished).toBe(true);
  expect(status.failure).toBeUndefined();
  expect(status.messages.some((message) => message.text.includes('fixture'))).toBe(true);
}, 15000);

it('waits for a server that has not connected until the caller cancels or the thread closes', async () => {
  // A server that never answers `initialize`: pi keeps waiting for it, and so does a call that names one of its tools.
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { silent: {
    command: process.execPath, args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], exposure: 'direct',
  } } }));
  await sessions.open(id, { cwd: base });
  const cancel = new AbortController();
  const cancelled = sessions.callMcpTool(id, 'silent', 'anything', {}, cancel.signal);
  const closed = sessions.readMcpResource(id, 'silent', 'ui://anything');
  expect(await settlesNow(cancelled)).toBe(false);
  cancel.abort();
  expect(await settlesNow(cancelled)).toBe(true);
  await expect(cancelled).rejects.toThrow('The call was cancelled while waiting for MCP server "silent" to connect.');
  expect(await settlesNow(closed)).toBe(false);
  sessions.dispose(id);
  expect(await settlesNow(closed)).toBe(true);
  await expect(closed).rejects.toThrow('The thread was closed while waiting for MCP server "silent" to connect.');
}, 15000);

it('waits for a tool that a later tools/list page offers instead of refusing it from the first page', async () => {
  const gate = join(base, 'page-2');
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { paged: {
    command: process.execPath, args: [fixture, 'paged', gate], exposure: 'direct',
  } } }));
  try {
    await sessions.open(id, { cwd: base });
    // Page one has reached pi-kit; pi registers nothing until the last page, which the fixture holds back.
    await vi.waitFor(() => expect(sessions.mcpTools(id, 'paged')).toEqual([{ name: 'first', description: 'On page one.' }]), { timeout: 10000, interval: 50 });
    const second = sessions.callMcpTool(id, 'paged', 'second', {});
    // A tool not on the pages seen so far may still be coming: the call waits rather than refusing.
    expect(await settlesNow(second)).toBe(false);
    writeFileSync(gate, '');
    expect(await second).toMatchObject({ structuredContent: { tool: 'second' } });
    // With the catalog complete, a tool that was on no page is refused at once.
    expect(sessions.mcpTools(id, 'paged').map((tool) => tool.name)).toEqual(['first', 'second']);
    const missing = sessions.callMcpTool(id, 'paged', 'third', {});
    expect(await settlesNow(missing)).toBe(true);
    await expect(missing).rejects.toThrow('The MCP server "paged" does not offer a tool "third".');
  } finally {
    // Whatever happened above, let the fixture answer so nothing waits on it while the session closes.
    writeFileSync(gate, '');
  }
}, 15000);

it('refuses a resource read from a connected server that declared no resources instead of waiting for one', async () => {
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { 'tools-only': {
    command: process.execPath, args: [fixture, 'tools-only'], exposure: 'direct',
  } } }));
  await sessions.open(id, { cwd: base });
  // The server initialized and listed its (empty) catalog: a tool it never offered is refused, so what it declared has reached pi-kit.
  await expect(sessions.callMcpTool(id, 'tools-only', 'anything', {})).rejects.toThrow('The MCP server "tools-only" does not offer a tool "anything".');
  const cancel = new AbortController();
  try {
    const read = sessions.readMcpResource(id, 'tools-only', 'ui://anything', cancel.signal);
    // pi's read_mcp_resource reaches only servers with resources; this one declared none, so there is nothing to wait for.
    expect(await settlesNow(read)).toBe(true);
    await expect(read).rejects.toThrow('The MCP server "tools-only" has no resources.');
  } finally {
    // Were the read still waiting, the caller's cancellation ends it instead of the session's close.
    cancel.abort();
  }
}, 15000);
