import { describe, expect, it } from 'vitest';
import { MCP_APP_MIME_TYPE, MCP_UI_EXTENSION, McpTap } from './mcp-tap';

type Msg = Record<string, unknown>;

class FakeTransport {
  sent: Msg[] = [];
  stderr = 'the tail';
  private listeners = new Set<(m: Msg) => void>();
  send(message: Msg): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  onMessage(listener: (m: Msg) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  receive(message: Msg): void {
    for (const l of this.listeners) l(message);
  }
}

function connect() {
  const tap = new McpTap();
  const inner = new FakeTransport();
  const wrapped = tap.wrap('issues', inner as never) as unknown as FakeTransport;
  const received: Msg[] = [];
  wrapped.onMessage((m) => received.push(m));
  return { tap, inner, wrapped, received };
}

describe('McpTap', () => {
  it('announces the MCP Apps extension in initialize and leaves other requests alone', async () => {
    const { inner, wrapped } = connect();
    await wrapped.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'x', capabilities: { roots: {} }, clientInfo: { name: 'pi' } } });
    await wrapped.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(inner.sent[0]).toMatchObject({
      params: { protocolVersion: 'x', capabilities: { roots: {}, extensions: { [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } } },
    });
    expect(inner.sent[1]).toEqual({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });

  it('records the UI resource of a listed tool, in the current and the earlier spelling, and forwards the answer unchanged', async () => {
    const { tap, inner, wrapped, received } = connect();
    await wrapped.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    const answer = {
      jsonrpc: '2.0',
      id: 7,
      result: {
        tools: [
          { name: 'open_form', _meta: { ui: { resourceUri: 'ui://issues/form' } } },
          { name: 'old_style', _meta: { 'ui/resourceUri': 'ui://issues/old' } },
          { name: 'plain' },
          { name: 'bad_uri', _meta: { ui: { resourceUri: 'https://x' } } },
        ],
      },
    };
    inner.receive(answer);
    expect(received).toEqual([answer]);
    expect(tap.uiResourceUri('issues', 'open_form')).toBe('ui://issues/form');
    expect(tap.uiResourceUri('issues', 'old_style')).toBe('ui://issues/old');
    expect(tap.uiResourceUri('issues', 'plain')).toBeUndefined();
    expect(tap.uiResourceUri('issues', 'bad_uri')).toBeUndefined();
    expect(tap.uiResourceUri('other', 'open_form')).toBeUndefined();
    expect(tap.uiTools('issues').sort()).toEqual(['old_style', 'open_form']);
  });

  it('replaces the tool list on a first page, adds to it on a next page, and knows the catalog only once the last page arrived', async () => {
    const { tap, inner, wrapped } = connect();
    const list = async (id: number, cursor: string | undefined, tools: Msg[], nextCursor?: string | null) => {
      await wrapped.send({ jsonrpc: '2.0', id, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) });
      inner.receive({ jsonrpc: '2.0', id, result: { tools, ...(nextCursor !== undefined ? { nextCursor } : {}) } });
    };
    expect(tap.knows('issues')).toBe(false);
    await list(1, undefined, [{ name: 'a', _meta: { ui: { resourceUri: 'ui://a' } } }], 'next');
    // The first page shows what it has, but a tool that is not on it may still be on the next: no verdict yet.
    expect(tap.uiTools('issues')).toEqual(['a']);
    expect(tap.knows('issues')).toBe(false);
    await list(2, 'next', [{ name: 'b', _meta: { ui: { resourceUri: 'ui://b' } } }]);
    expect(tap.uiTools('issues').sort()).toEqual(['a', 'b']);
    expect(tap.knows('issues')).toBe(true);
    // A fresh listing (`notifications/tools/list_changed`) starts over and is open again until its last page.
    await list(3, undefined, [{ name: 'c' }], 'more');
    expect(tap.uiTools('issues')).toEqual([]);
    expect(tap.toolList('issues')).toEqual([{ name: 'c' }]);
    expect(tap.knows('issues')).toBe(false);
    // Some servers end with `nextCursor: null` (or `""`) instead of leaving it out; pi's client takes that as the end too.
    await list(4, 'more', [{ name: 'd' }], null);
    expect(tap.knows('issues')).toBe(true);
    // A reconnect wraps a new transport: what the old connection listed stays on the card, but the catalog is open
    // until the new connection has listed it.
    const again = new FakeTransport();
    const rewrapped = tap.wrap('issues', again as never) as unknown as FakeTransport;
    rewrapped.onMessage(() => undefined);
    expect(tap.toolList('issues').map((t) => t.name)).toEqual(['c', 'd']);
    expect(tap.knows('issues')).toBe(false);
    await rewrapped.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    again.receive({ jsonrpc: '2.0', id: 5, result: { tools: [{ name: 'e' }] } });
    expect(tap.knows('issues')).toBe(true);
    expect(tap.toolList('issues')).toEqual([{ name: 'e' }]);
    tap.forget('issues');
    expect(tap.knows('issues')).toBe(false);
    expect(tap.toolList('issues')).toEqual([]);
    await rewrapped.send({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
    again.receive({ jsonrpc: '2.0', id: 6, result: { tools: [{ name: 'e' }] } });
    expect(tap.knows('issues')).toBe(true);
    tap.clear();
    expect(tap.knows('issues')).toBe(false);
  });

  it('learns from the initialize result whether a server has resources and whether pi will list its tools at all', async () => {
    const { tap, inner, wrapped } = connect();
    const initialize = async (transport: FakeTransport, through: FakeTransport, id: number, capabilities: Msg) => {
      await through.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 'x', capabilities: {}, clientInfo: { name: 'pi' } } });
      transport.receive({ jsonrpc: '2.0', id, result: { protocolVersion: 'x', capabilities, serverInfo: { name: 's', version: '1' } } });
    };
    // Unknown until pi initialized the connection.
    expect(tap.hasResources('issues')).toBeUndefined();
    await initialize(inner, wrapped, 1, { tools: {} });
    // Tools only: no resources, and the catalog is still open because pi is about to ask for the tools.
    expect(tap.hasResources('issues')).toBe(false);
    expect(tap.knows('issues')).toBe(false);
    // A reconnect starts from nothing again.
    const again = new FakeTransport();
    const rewrapped = tap.wrap('issues', again as never) as unknown as FakeTransport;
    rewrapped.onMessage(() => undefined);
    expect(tap.hasResources('issues')).toBeUndefined();
    await initialize(again, rewrapped, 2, { resources: {} });
    expect(tap.hasResources('issues')).toBe(true);
    // Without a `tools` capability pi never sends `tools/list`, so the catalog is complete and empty.
    expect(tap.knows('issues')).toBe(true);
    expect(tap.toolList('issues')).toEqual([]);
    tap.forget('issues');
    expect(tap.hasResources('issues')).toBeUndefined();
    expect(tap.knows('issues')).toBe(false);
    await initialize(again, rewrapped, 3, { resources: {}, tools: {} });
    expect(tap.hasResources('issues')).toBe(true);
    tap.clear();
    expect(tap.hasResources('issues')).toBeUndefined();
  });

  it('lists the tools a server offered with the first line of their description and the MCP App they open (the connector card)', async () => {
    const { tap, inner, wrapped } = connect();
    await wrapped.send({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
    inner.receive({
      jsonrpc: '2.0',
      id: 8,
      result: {
        tools: [
          { name: 'create_issue', description: 'Creates an issue.\nMore text that does not belong on a card.' },
          { name: 'open_form', title: 'Open the form', _meta: { ui: { resourceUri: 'ui://issues/form' } } },
          { name: 'bare' },
        ],
      },
    });
    expect(tap.toolList('issues')).toEqual([{ name: 'create_issue', description: 'Creates an issue.' }, { name: 'open_form', description: 'Open the form', app: 'ui://issues/form' }, { name: 'bare' }]);
    expect(tap.toolList('other')).toEqual([]);
  });

  it('keeps the _meta of a resource that was read', async () => {
    const { tap, inner, wrapped } = connect();
    await wrapped.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://issues/form' } });
    inner.receive({ jsonrpc: '2.0', id: 3, result: { contents: [{ uri: 'ui://issues/form', text: '<p/>', _meta: { ui: { csp: { resourceDomains: ['https://cdn.example'] } } } }] } });
    expect(tap.resourceMeta('issues', 'ui://issues/form')).toEqual({ ui: { csp: { resourceDomains: ['https://cdn.example'] } } });
    tap.forget('issues');
    expect(tap.resourceMeta('issues', 'ui://issues/form')).toBeUndefined();
  });

  it('keeps the metadata of every outstanding resource request beyond the former 256-request cutoff', async () => {
    const { tap, inner, wrapped } = connect();
    for (let id = 0; id <= 256; id++) await wrapped.send({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri: `ui://issues/${id}` } });
    const meta = { ui: { csp: { resourceDomains: ['https://cdn.example'] } } };
    inner.receive({ jsonrpc: '2.0', id: 0, result: { contents: [{ uri: 'ui://issues/0', _meta: meta }] } });
    expect(tap.resourceMeta('issues', 'ui://issues/0')).toEqual(meta);
  });

  it.each(['error', 'cancelled'])('does not publish a late metadata result after its request was %s', async (end) => {
    const { tap, inner, wrapped } = connect();
    await wrapped.send({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'ui://issues/finished' } });
    if (end === 'error') inner.receive({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Read failed' } });
    else await wrapped.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    inner.receive({ jsonrpc: '2.0', id: 7, result: { contents: [{ uri: 'ui://issues/finished', _meta: { ui: { csp: {} } } }] } });
    expect(tap.resourceMeta('issues', 'ui://issues/finished')).toBeUndefined();
  });

  it('passes other properties through, bound to the real transport', () => {
    const { wrapped } = connect();
    expect(wrapped.stderr).toBe('the tail');
  });

  it('ignores errors, notifications and answers it did not ask for', () => {
    const { tap, inner, received } = connect();
    inner.receive({ jsonrpc: '2.0', id: 99, error: { code: -1, message: 'no' } });
    inner.receive({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    inner.receive({ jsonrpc: '2.0', id: 5, result: { tools: [{ name: 'x', _meta: { ui: { resourceUri: 'ui://x' } } }] } });
    expect(received).toHaveLength(3);
    expect(tap.uiTools('issues')).toEqual([]);
  });
});
