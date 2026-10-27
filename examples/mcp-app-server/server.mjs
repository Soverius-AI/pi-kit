#!/usr/bin/env node
/**
 * A minimal MCP server that ships an MCP App (pi-kit). No dependencies: MCP over stdio is newline-delimited
 * JSON-RPC, and the handful of methods an MCP App needs fit in this file.
 *
 *   tools     open_issue_form   links the ui://issues/create resource: its result is rendered as the form below
 *             create_issue      what the form's "Create issue" button calls (an app can call tools of its server)
 *   resource  ui://issues/create  the form, an HTML page that speaks the MCP Apps postMessage protocol
 *
 * Issues are kept in memory. The server announces the UI only to a host that announced the MCP Apps extension in
 * `initialize` (`io.modelcontextprotocol/ui`), as the spec asks; pi-kit does, pi's own client does not.
 */
import { createInterface } from 'node:readline';

const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const RESOURCE_URI = 'ui://issues/create';
const MIME = 'text/html;profile=mcp-app';
const issues = [];
let hostShowsUi = false;

const FORM_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>
  :root { --bg:#1c1e23; --card:#23262c; --fg:#e4e6ea; --muted:#9a9fa8; --line:#30343b; --accent:#e3b457; --accent-fg:#1c1e23; --ok:#7fbf8e; --err:#e27a72; }
  :root[data-theme="light"] { --bg:#f2f3f5; --card:#fff; --fg:#1d2026; --muted:#6b707a; --line:#e1e3e8; --accent:#8e6512; --accent-fg:#fff; --ok:#2f7d4b; --err:#b5362e; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 14px/22px "IBM Plex Sans", system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  form { display: flex; flex-direction: column; gap: 12px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 18px; }
  input, select { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; height: 32px; }
  input:focus, select:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
  button { font: inherit; font-size: 13px; height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 500; }
  button:disabled { opacity: .5; cursor: default; }
  .done { display: none; flex-direction: column; gap: 8px; }
  .done strong { color: var(--ok); font-weight: 500; }
  .error { color: var(--err); font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
<form id="form">
  <label>Title <input id="title" name="title" required placeholder="What is wrong?"></label>
  <div class="row">
    <label>Team <select id="team"><option>Platform</option><option>Reporting</option><option>Growth</option></select></label>
    <label>Priority <select id="priority"><option>Low</option><option>Medium</option><option selected>High</option><option>Urgent</option></select></label>
  </div>
  <div class="error" id="error" role="alert"></div>
  <div class="actions">
    <button type="button" id="cancel">Cancel</button>
    <button type="submit" class="primary" id="create">Create issue</button>
  </div>
</form>
<div class="done" id="done" role="status">
  <div><strong id="created"></strong></div>
  <div id="summary" style="color: var(--muted)"></div>
  <div class="actions" style="justify-content:flex-start"><button type="button" id="tell">Tell pi</button></div>
</div>
<script>
  // The MCP Apps view protocol: JSON-RPC over postMessage with the host (here, a sandbox proxy that relays to it).
  let nextId = 1;
  const pending = new Map();
  const send = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ id, method, params }); });
  const $ = (id) => document.getElementById(id);
  let lastIssue;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && !message.method) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-input') {
      if (message.params?.arguments?.title) $('title').value = message.params.arguments.title;
    } else if (message.method === 'ui/notifications/tool-result') {
      const title = message.params?.structuredContent?.title;
      if (title && !$('title').value) $('title').value = title;
    } else if (message.method === 'ui/notifications/host-context-changed') {
      applyContext(message.params);
    }
  });

  function applyContext(context) {
    if (!context) return;
    if (context.theme) document.documentElement.dataset.theme = context.theme;
    for (const [name, value] of Object.entries(context.styles?.variables ?? {})) document.documentElement.style.setProperty(name, value);
  }
  function resize() { send({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(document.documentElement.getBoundingClientRect().height) } }); }
  new ResizeObserver(resize).observe(document.body);

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('create').disabled = true;
    $('error').textContent = '';
    try {
      const result = await request('tools/call', { name: 'create_issue', arguments: { title: $('title').value, team: $('team').value, priority: $('priority').value } });
      if (result.isError) throw new Error(result.content?.[0]?.text ?? 'The server refused.');
      lastIssue = result.structuredContent;
      $('created').textContent = 'Created ' + lastIssue.id;
      $('summary').textContent = lastIssue.title + ', ' + lastIssue.team + ', ' + lastIssue.priority;
      $('form').style.display = 'none';
      $('done').style.display = 'flex';
    } catch (error) {
      $('error').textContent = error.message;
      $('create').disabled = false;
    }
  });
  $('cancel').addEventListener('click', () => { $('title').value = ''; $('error').textContent = ''; });
  $('tell').addEventListener('click', () => {
    request('ui/message', { role: 'user', content: [{ type: 'text', text: 'I created ' + lastIssue.id + ' (' + lastIssue.title + '). Thanks!' }] }).catch((error) => { $('error').textContent = error.message; });
  });

  (async () => {
    const init = await request('ui/initialize', { protocolVersion: '2025-06-18', appInfo: { name: 'issues-form', version: '1.0.0' }, appCapabilities: {} });
    applyContext(init?.hostContext);
    send({ method: 'ui/notifications/initialized', params: {} });
    resize();
  })().catch((error) => { $('error').textContent = error.message; });
</script>
</body>
</html>`;

const TOOLS = () => [
  {
    name: 'open_issue_form',
    description: 'Opens a form for the user to create an issue. Optionally prefill the title. The form is shown to the user; the issue is created when they press the button.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Suggested issue title' } } },
    ...(hostShowsUi ? { _meta: { ui: { resourceUri: RESOURCE_URI }, 'ui/resourceUri': RESOURCE_URI } } : {}),
  },
  {
    name: 'create_issue',
    description: 'Creates an issue in the in-memory tracker and returns its id.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, team: { type: 'string' }, priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Urgent'] } },
      required: ['title'],
    },
    annotations: { destructiveHint: false },
  },
];

function callTool(name, args = {}) {
  if (name === 'open_issue_form') {
    const title = typeof args.title === 'string' ? args.title : '';
    return { content: [{ type: 'text', text: title ? `Opened the issue form, prefilled with "${title}".` : 'Opened the issue form.' }], structuredContent: { title } };
  }
  if (name === 'create_issue') {
    const title = String(args.title ?? '').trim();
    if (!title) return { isError: true, content: [{ type: 'text', text: 'An issue needs a title.' }] };
    const issue = { id: `ISSUE-${issues.length + 1}`, title, team: String(args.team ?? 'Platform'), priority: String(args.priority ?? 'High') };
    issues.push(issue);
    return { content: [{ type: 'text', text: `Created ${issue.id}: ${issue.title} (${issue.team}, ${issue.priority}).` }], structuredContent: issue };
  }
  return undefined;
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      hostShowsUi = Boolean(params?.capabilities?.extensions?.[UI_EXTENSION]);
      process.stderr.write(`client ${params?.clientInfo?.name ?? '?'} ${hostShowsUi ? 'supports' : 'does not announce'} MCP Apps\n`);
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'issues-demo', version: '1.0.0' },
        instructions: 'A toy issue tracker. open_issue_form shows a form to the user; do not call create_issue yourself unless asked.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS() };
    case 'tools/call': {
      const result = callTool(params?.name, params?.arguments);
      if (!result) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
      return result;
    }
    case 'resources/list':
      return { resources: [{ uri: RESOURCE_URI, name: 'Create issue form', mimeType: MIME }] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read':
      if (params?.uri !== RESOURCE_URI) throw Object.assign(new Error(`Unknown resource: ${params?.uri}`), { code: -32002 });
      return { contents: [{ uri: RESOURCE_URI, mimeType: MIME, text: FORM_HTML, _meta: { ui: { csp: {} } } }] };
    default:
      if (id === undefined) return undefined; // a notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const result = handle(message);
    if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  } catch (error) {
    if (message.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`);
    }
  }
});
