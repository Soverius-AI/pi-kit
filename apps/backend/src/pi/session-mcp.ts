import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentSession } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { McpTap } from '../mcp/mcp-tap';

/** What an extension command said through `ctx.ui.notify`. */
export interface McpMessage {
  text: string;
  level: string;
}

interface McpToolOutcome {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** An MCP `CallToolResult` from a pi tool result: pi keeps the server's whole result (minus `_meta`) as `structuredContent`. */
export function mcpCallToolResult(outcome: McpToolOutcome): Record<string, unknown> {
  const structured = outcome.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured) && Array.isArray((structured as { content?: unknown }).content)) {
    return structured as Record<string, unknown>;
  }
  return { content: outcome.content ?? [], ...(outcome.isError ? { isError: true } : {}) };
}

export interface McpCommandOptions {
  timeoutMs: number;
  until?: (messages: McpMessage[]) => boolean;
  /** The redirect URL, or undefined to give up; absent input waits for pi to abort its question. */
  input?: (signal?: AbortSignal) => Promise<string | undefined>;
}

export interface McpCommandResult {
  messages: McpMessage[];
  finished: boolean;
  failure?: string;
  done: Promise<void>;
}

/** How often a call looks for the tool pi is about to register for a server that is still connecting. */
const REGISTRATION_POLL_MS = 100;

/** MCP command notifications and direct app calls over one session's existing connections. */
export class SessionMcp {
  /** Aborted when the session is released: a wait for a server to connect and a tool call under way end with it. */
  private readonly closed = new AbortController();

  constructor(
    private readonly session: AgentSession,
    private readonly tap: McpTap,
  ) {}

  /** The session is gone: whatever still waits for one of its servers, or runs on one, fails now and stops. */
  dispose(): void {
    this.closed.abort(new Error('The thread was closed.'));
  }

  /**
   * Runs one of the MCP extension's own commands (`/mcp`, `/mcp reconnect <server>`, `/mcp login <server>`, ...)
   * with a context that collects what the command tells the user instead of broadcasting it. pi keeps its connection
   * states inside the extension, and this command is its public way to report and change them (docs/mcp.md).
   *
   * Resolves when the command has said something that `until` accepts, when it finished, or after `timeoutMs`;
   * a command that is still running then carries on in the background (a sign-in waits for the browser).
   */
  async command(args: string, options: McpCommandOptions): Promise<McpCommandResult> {
    const { session } = this;
    const command = session.extensionRunner.getCommand('mcp');
    if (!command) throw new Error('This pi session has no /mcp command (MCP support is replaced or turned off).');
    const base = session.extensionRunner.createCommandContext();
    const messages: McpMessage[] = [];
    let wake: () => void = () => undefined;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    // A sign-in that cannot reach this machine's browser would ask the user to paste the redirect URL. There is no
    // run to show that question in (the thread is idle), so these wait for pi to give up on them instead.
    const unanswered = (_title: string, _a?: unknown, _b?: unknown, opts?: { signal?: AbortSignal }) =>
      new Promise<undefined>((resolve) => opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }));
    const ui = Object.create(base.ui, {
      notify: {
        value: (text: string, level?: string) => {
          messages.push({ text, level: level ?? 'info' });
          if (options.until?.(messages)) wake();
        },
      },
      input: { value: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => (options.input ? options.input(opts?.signal) : unanswered(title, placeholder, undefined, opts)) },
    }) as typeof base.ui;
    const ctx = Object.create(base, { ui: { value: ui } }) as typeof base;
    let finished = false;
    let failure: string | undefined;
    const run = command.handler(args, ctx).then(
      () => undefined,
      (error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
      },
    );
    void run.finally(() => {
      finished = true;
      wake();
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([woken, new Promise<void>((resolve) => (timer = setTimeout(resolve, options.timeoutMs)))]);
    clearTimeout(timer);
    return { messages, finished, ...(failure ? { failure } : {}), done: run };
  }

  /**
   * Calls a tool of an MCP server the way an MCP App asks for it (`tools/call` through the AG-UI agent): the pi tool
   * `mcp__<server>__<tool>` on the connection pi already holds. The model is not involved, so pi's `tool_call`
   * hooks (permission extensions) do not run; the click in the app is the user's own act.
   */
  async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const stop = this.lifetime(signal);
    const label = `${server}/${tool}`;
    const definition = await this.untilRegistered(server, () => {
      const found = this.session.getAllTools().map((info) => this.session.getToolDefinition(info.name)).find((candidate) => candidate?.label === label);
      // A tool missing from the complete catalog (every `tools/list` page seen) is one the server does not offer;
      // while the listing still pages, or has not started, the tool may yet come, so wait.
      if (!found && this.tap.knows(server) && !this.tap.toolList(server).some((listed) => listed.name === tool))
        throw new Error(`The MCP server "${server}" does not offer a tool "${tool}".`);
      return found;
    }, stop);
    stop.throwIfAborted();
    const result = (await definition.execute(`app-${randomUUID()}`, args as never, stop, undefined, undefined as never)) as McpToolOutcome;
    return mcpCallToolResult(result);
  }

  /**
   * `resources/read` for an MCP App's `ui://` resource, through pi's `read_mcp_resource` on the connection pi holds.
   * pi registers that tool only once a connected server declares resources, so a server whose `initialize` result
   * (seen by the tap) declares none is refused at once instead of waiting for a registration that never comes.
   */
  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<{ contents: Record<string, unknown>[] }> {
    const { session, tap } = this;
    const stop = this.lifetime(signal);
    const definition = await this.untilRegistered(server, () => {
      if (tap.hasResources(server) === false) throw new Error(`The MCP server "${server}" has no resources.`);
      return session.getToolDefinition('read_mcp_resource');
    }, stop);
    stop.throwIfAborted();
    const outcome = (await definition.execute(`app-${randomUUID()}`, { server, uri } as never, stop, undefined, undefined as never)) as McpToolOutcome;
    const structured = outcome.structuredContent as { contents?: Record<string, unknown>[] } | undefined;
    // pi's tool drops `_meta` (the CSP an app asks for); the tap saw it on the way.
    const meta = tap.resourceMeta(server, uri);
    return { contents: (structured?.contents ?? []).map((c) => (meta && c['uri'] === uri ? { ...c, _meta: meta } : c)) };
  }

  /** Wait for the requested definition; `find` throws when what the tap saw of the server proves the wait pointless (a missing tool, no resources). */
  private async untilRegistered<T>(server: string, find: () => T | undefined, stop: AbortSignal): Promise<T> {
    try {
      for (;;) {
        stop.throwIfAborted();
        const found = find();
        if (found) return found;
        await sleep(REGISTRATION_POLL_MS, undefined, { signal: stop });
      }
    } catch (error) {
      if (!stop.aborted) throw error;
      const why = this.closed.signal.aborted ? 'The thread was closed' : 'The call was cancelled';
      throw new Error(`${why} while waiting for MCP server "${server}" to connect.`, { cause: error });
    }
  }

  /** The caller's cancellation, if it brought one, joined with the session's lifetime; one signal per call, so what a call listens for goes with it. */
  private lifetime(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.closed.signal]) : this.closed.signal;
  }
}
