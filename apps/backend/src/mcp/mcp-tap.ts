import { uiResourceUriOf } from '@pi-kit/protocol';

/**
 * A listening post on pi's MCP connections.
 *
 * pi connects its MCP servers inside `createMcpExtension` and keeps what it learns (which tools carry a
 * `_meta.ui.resourceUri`, a resource's `_meta`) to itself: tool definitions drop `_meta`, and `read_mcp_resource`
 * drops it from what it returns. MCP Apps need both. The extension takes a `createTransport` option, so
 * `PiSessionService` hands it a factory whose transports are wrapped by `McpTap.wrap()`: the wrapper forwards
 * everything unchanged, reads the `initialize`, `tools/list` and `resources/read` answers on their way to pi's
 * client, and announces the MCP Apps extension in `initialize` (a server may leave out its UI tools for a client
 * that does not). There is still one process (stdio) or one session (HTTP) per server, pi's own.
 */

type JsonRpcMessage = Record<string, unknown> & { jsonrpc?: string; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** The part of pi's `McpTransport` (`@earendil-works/pi-mcp`) the tap touches. */
export interface TappableTransport {
  send(message: never, options?: never): Promise<void>;
  onMessage(listener: (message: never) => void): () => void;
}

/** The capability key MCP Apps clients announce in `initialize` (SEP-1865). */
export const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';
/** The MIME type of an MCP App resource. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';


export interface McpToolMeta {
  /** `_meta` of the tool as the server listed it. */
  meta?: Record<string, unknown>;
  /** The first line of the tool's description (or its title), for the connector's tool list. */
  description?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the tap has seen of one server over its current connection. */
interface ServerState {
  /** The tools listed so far, in the server's order: the first `tools/list` page replaces them, later pages add. */
  tools: Map<string, McpToolMeta>;
  /** True once the last `tools/list` page arrived (no `nextCursor`): a tool that is not in `tools` is really missing. */
  listed: boolean;
  /** Whether the server's `initialize` result declared `resources`; undefined until pi initialized this connection. */
  resources?: boolean;
}

/**
 * What the tap learnt from each of pi's MCP servers: the tools it listed, with their `_meta` and first description
 * line, and the `_meta` of every resource read. `wrap()` puts it on a transport; the rest feeds the connector card
 * and the MCP Apps panel.
 */
export class McpTap {
  private readonly servers = new Map<string, ServerState>();
  private readonly resources = new Map<string, Record<string, unknown>>();

  /**
   * True once the server has listed all its tools over its current connection, so `toolList` is its whole catalog
   * and a tool missing from it is one the server does not offer. False while `tools/list` is still paging (pi
   * registers the tools only after the last page) and from a reconnect until the new connection has listed again.
   */
  knows(server: string): boolean {
    return this.servers.get(server)?.listed === true;
  }

  /**
   * Whether the server declared `resources` in its `initialize` result, the condition under which pi makes its
   * `read_mcp_resource` reach the server; undefined until pi initialized the current connection.
   */
  hasResources(server: string): boolean | undefined {
    return this.servers.get(server)?.resources;
  }

  /** `ui://` resource a server's tool links (MCP Apps), if the server listed one. */
  uiResourceUri(server: string, tool: string): string | undefined {
    return uiResourceUriOf(this.tools(server)?.get(tool)?.meta);
  }

  /**
   * Whether an MCP App may call the tool: MCP Apps let a tool say who may call it with `_meta.ui.visibility`
   * (`["model"]` keeps it away from the app, `["app"]` away from the model). No `visibility` means both.
   */
  appMayCall(server: string, tool: string): boolean {
    const ui = this.tools(server)?.get(tool)?.meta?.['ui'];
    const visibility = isRecord(ui) ? ui['visibility'] : undefined;
    return !Array.isArray(visibility) || visibility.includes('app');
  }

  /** The tools a server listed, in its order, with the `ui://` resource each links (the connector card lists them). */
  toolList(server: string): { name: string; description?: string; app?: string }[] {
    return [...(this.tools(server) ?? [])].map(([name, tool]) => {
      const app = uiResourceUriOf(tool.meta);
      return { name, ...(tool.description ? { description: tool.description } : {}), ...(app ? { app } : {}) };
    });
  }

  /** Tools of a server with a UI, for the panel. */
  uiTools(server: string): string[] {
    return [...(this.tools(server) ?? [])].filter(([, t]) => uiResourceUriOf(t.meta)).map(([name]) => name);
  }

  /** `_meta` the server sent with a resource (`ui.csp`, `ui.permissions`, ...), from the last time it was read. */
  resourceMeta(server: string, uri: string): Record<string, unknown> | undefined {
    return this.resources.get(`${server}\0${uri}`);
  }

  /** Forgets everything (the session reloads and every server is listed again). */
  clear(): void {
    this.servers.clear();
    this.resources.clear();
  }

  forget(server: string): void {
    this.servers.delete(server);
    for (const key of this.resources.keys()) if (key.startsWith(`${server}\0`)) this.resources.delete(key);
  }

  private tools(server: string): Map<string, McpToolMeta> | undefined {
    return this.servers.get(server)?.tools;
  }

  private state(server: string): ServerState {
    let state = this.servers.get(server);
    if (!state) this.servers.set(server, (state = { tools: new Map(), listed: false }));
    return state;
  }

  /**
   * Wraps one transport. A `Proxy`, not a subclass: pi checks `transport instanceof StdioTransport` and reads
   * `transport.stderr`, and both keep working because every other property is the real transport's.
   */
  wrap<T extends TappableTransport>(server: string, transport: T): T {
    // pi makes a transport per connection attempt, so this is a (re)connect: the catalog and capabilities belong
    // to the new connection once it has initialized and listed. What the old one listed stays for the card.
    const state = this.state(server);
    state.listed = false;
    delete state.resources;
    const pending = new Map<string | number, { method: string; params: unknown }>();
    const send = (message: JsonRpcMessage, options?: never): Promise<void> => {
      let out = message;
      if (message.method === 'notifications/cancelled' && isRecord(message.params)) {
        const id = message.params['requestId'];
        if (typeof id === 'string' || typeof id === 'number') pending.delete(id);
      }
      if (message.id !== undefined && (message.method === 'initialize' || message.method === 'tools/list' || message.method === 'resources/read')) {
        pending.set(message.id, { method: message.method, params: message.params });
        if (message.method === 'tools/list' && (!isRecord(message.params) || !message.params['cursor'])) this.state(server).listed = false;
        if (message.method === 'initialize') out = withUiCapability(message);
      }
      return transport.send(out as never, options);
    };
    const onMessage = (listener: (message: never) => void): (() => void) =>
      transport.onMessage(((message: JsonRpcMessage) => {
        try {
          this.observe(server, message, pending);
        } catch {
          // Observing must never break pi's connection.
        }
        listener(message as never);
      }) as never);
    return new Proxy(transport, {
      get(target, prop) {
        if (prop === 'send') return send;
        if (prop === 'onMessage') return onMessage;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  private observe(server: string, message: JsonRpcMessage, pending: Map<string | number, { method: string; params: unknown }>): void {
    if (message.id === undefined || typeof message.method === 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (!isRecord(message.result)) return;
    const result = message.result;
    if (request.method === 'initialize' && isRecord(result['capabilities'])) {
      const capabilities = result['capabilities'];
      const state = this.state(server);
      // The same tests pi applies (`McpServerConnection.connectOnce`): `resources` present means it has resources,
      // and it asks `tools/list` only of a server that declares `tools`, so without them the catalog is complete and empty.
      state.resources = capabilities['resources'] !== undefined;
      if (capabilities['tools'] === undefined) {
        state.tools = new Map();
        state.listed = true;
      }
    } else if (request.method === 'tools/list' && Array.isArray(result['tools'])) {
      // The first page (no cursor) replaces what we knew; later pages add to it. The catalog is complete with the
      // page that has no `nextCursor` (some servers end with `null` or `""`; pi's client takes those as the end too).
      const cursor = isRecord(request.params) ? request.params['cursor'] : undefined;
      const state = this.state(server);
      if (!cursor) state.tools = new Map();
      for (const tool of result['tools']) {
        if (isRecord(tool) && typeof tool['name'] === 'string') {
          const text = typeof tool['description'] === 'string' && tool['description'].trim() ? tool['description'] : typeof tool['title'] === 'string' ? tool['title'] : '';
          const description = text.split('\n')[0].trim().slice(0, 200);
          state.tools.set(tool['name'], { ...(isRecord(tool['_meta']) ? { meta: tool['_meta'] } : {}), ...(description ? { description } : {}) });
        }
      }
      const next = result['nextCursor'];
      state.listed = next === undefined || next === null || next === '';
    } else if (request.method === 'resources/read' && Array.isArray(result['contents'])) {
      for (const content of result['contents']) {
        if (isRecord(content) && typeof content['uri'] === 'string' && isRecord(content['_meta'])) {
          this.resources.set(`${server}\0${content['uri']}`, content['_meta']);
        }
      }
    }
  }
}

/** `initialize` params with the MCP Apps extension added to the client's capabilities. */
export function withUiCapability(message: JsonRpcMessage): JsonRpcMessage {
  const params = isRecord(message.params) ? message.params : {};
  const capabilities = isRecord(params['capabilities']) ? params['capabilities'] : {};
  const extensions = isRecord(capabilities['extensions']) ? capabilities['extensions'] : {};
  return {
    ...message,
    params: {
      ...params,
      capabilities: { ...capabilities, extensions: { ...extensions, [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } },
    },
  };
}
