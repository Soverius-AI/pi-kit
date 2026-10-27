import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type McpActionResult,
  type McpOverview,
  type McpServer,
  type McpSignIn,
  type McpState,
  type ProxiedMcpRequest,
  PROXIED_MCP_METHODS,
} from '@pi-kit/protocol';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { type McpConfigEntry, projectMcpConfigPath, readMcpConfig, setMcpServerEnabled, userMcpConfigPath } from './mcp-config';
import { type McpStatusReport, parseMcpStatus } from './mcp-status';

/** How long the panel waits for pi's report before it shows the servers that are still connecting as such. */
const STATUS_TIMEOUT_MS = 3000;
const ACTION_TIMEOUT_MS = 20_000;
const LOGIN_URL_TIMEOUT_MS = 15_000;

/**
 * The MCP panel's backend and the MCP Apps relay.
 *
 * pi keeps its MCP connections inside `createMcpExtension`. What we can see of them is what pi reports through
 * its own `/mcp` command (states, tool counts, errors), what the files say (`mcp.json`, read here so the panel
 * works before a server connects and shows where each entry lives) and what the transport tap heard (which tools
 * link a `ui://` resource). Changes go through pi as well: `/mcp reconnect|login|logout <server>` for those,
 * and the config file plus a session reload for enable / disable, which pi only offers in its TUI.
 */
@Injectable()
export class McpService {
  /** Sign-ins this process started, by thread and server: waiting for the browser, or how the last one ended. */
  private readonly signIns = new Map<string, SignInRun>();
  /** The answer to pi's "paste the redirect URL" question of each waiting sign-in: a URL finishes it, nothing gives it up. */
  private readonly answers = new Map<string, (value: string | undefined) => void>();

  constructor(
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
  ) {}

  // ---- the panel

  /**
   * The servers of a thread's session. Without a thread only the user-level configuration is known (state
   * `unknown`), which is enough for the sidebar's count before any thread is open.
   */
  async overview(threadId?: string): Promise<McpOverview> {
    const agentDir = await this.sessions.agentDir();
    if (!threadId) {
      const config = readMcpConfig({ agentDir, projectTrusted: false });
      return this.compose(config, undefined, false);
    }
    await this.threads.openSession(threadId);
    const trusted = this.sessions.isProjectTrusted(threadId);
    const config = readMcpConfig({ agentDir, cwd: this.threads.cwdOf(threadId), projectTrusted: trusted });
    const report = await this.status(threadId);
    return this.compose(config, report, trusted, threadId);
  }

  /** The path of one of the two `mcp.json` files. The project's is the folder of the thread (`.pi/mcp.json`); without a thread there is no project file to name. */
  async filePath(scope: 'user' | 'project', threadId?: string): Promise<string> {
    if (scope === 'user') return userMcpConfigPath(await this.sessions.agentDir());
    if (!threadId) throw new BadRequestException('thread: the project’s mcp.json belongs to the folder of a thread.');
    await this.threads.openSession(threadId);
    return projectMcpConfigPath(this.threads.cwdOf(threadId));
  }

  async setEnabled(threadId: string, name: string, enabled: boolean): Promise<McpActionResult> {
    const entry = await this.entry(threadId, name);
    this.requireIdle(threadId, 'change MCP servers');
    try {
      const path = setMcpServerEnabled(entry, enabled);
      // pi reads `mcp.json` when a session starts; its own manager applies the change live, but only in the TUI.
      await this.sessions.reload(threadId);
      return { message: `${enabled ? 'Enabled' : 'Disabled'} ${name} in ${path}.`, overview: await this.overview(threadId) };
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
  }

  async reconnect(threadId: string, name: string): Promise<McpActionResult> {
    await this.entry(threadId, name);
    const result = await this.sessions.mcpCommand(threadId, `reconnect ${name}`, { timeoutMs: ACTION_TIMEOUT_MS });
    return { message: lastMessage(result), overview: await this.overview(threadId) };
  }

  /**
   * Starts the OAuth sign-in (`/mcp login <server>`): pi registers a client, opens the authorization page in the
   * system browser and waits for the redirect on its loopback port. The call returns when pi has told us the URL
   * (so the panel can offer it as a link if the browser did not open), while the sign-in carries on in the background.
   */
  async login(threadId: string, name: string): Promise<McpActionResult> {
    await this.entry(threadId, name);
    const key = signInKey(threadId, name);
    // A sign-in still waiting for its browser is given up before the next one starts: pi would listen on two ports otherwise.
    this.answers.get(key)?.(undefined);
    const state: SignInRun = { phase: 'waiting' };
    this.signIns.set(key, state);
    let answer: (value: string | undefined) => void = () => undefined;
    const answered = new Promise<string | undefined>((resolve) => (answer = resolve));
    this.answers.set(key, answer);
    const result = await this.sessions.mcpCommand(threadId, `login ${name}`, {
      timeoutMs: LOGIN_URL_TIMEOUT_MS,
      until: (messages) => messages.length > 0,
      input: (signal) => {
        signal?.addEventListener('abort', () => answer(undefined), { once: true });
        return answered;
      },
    });
    const text = lastMessage(result);
    const url = /https?:\/\/\S+/.exec(text ?? '')?.[0];
    if (url) state.url = url;
    // What the sign-in ends as is decided when pi's command returns: success leaves nothing, anything else is kept for the card.
    const settle = (): void => {
      if (this.answers.get(key) === answer) this.answers.delete(key);
      if (this.signIns.get(key) !== state) return;
      const outcome = signInOutcome(result.messages, result.failure);
      if (outcome === 'done') this.signIns.delete(key);
      else {
        state.phase = outcome.phase;
        state.message = outcome.message;
        delete state.url;
      }
    };
    void result.done.then(settle);
    // A sign-in that failed before it had a page to show (the server does not register clients) is over by now: the first answer already says so.
    await Promise.race([result.done, new Promise((resolve) => setTimeout(resolve, 150))]);
    // The panel shows the link as a link; the sentence is what pi said without it.
    const message = url ? (text ?? '').split(url)[0].trim().replace(/:$/, '.') : text;
    return { ...(message ? { message } : {}), ...(url ? { url } : {}), overview: await this.overview(threadId) };
  }

  /** The person gave up: pi's own sign-in is told there is no redirect to wait for, stops listening and says "Sign-in cancelled." */
  async cancelSignIn(threadId: string, name: string): Promise<McpActionResult> {
    this.answers.get(signInKey(threadId, name))?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { overview: await this.overview(threadId) };
  }

  /** The browser ran on another machine: the redirect URL the person copied from its address bar finishes the sign-in, as pi's own prompt asks. */
  async pasteSignIn(threadId: string, name: string, redirectUrl: string): Promise<McpActionResult> {
    const answer = this.answers.get(signInKey(threadId, name));
    if (!answer) throw new ConflictException(`No sign-in to "${name}" is waiting for a redirect URL.`);
    answer(redirectUrl);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { overview: await this.overview(threadId) };
  }

  /** What the card shows of a sign-in: the page it waits for, or why it ended. Forgotten once the server is connected. */
  signInOf(threadId: string, name: string): McpSignIn | undefined {
    const state = this.signIns.get(signInKey(threadId, name));
    return state ? { phase: state.phase, ...(state.url ? { url: state.url } : {}), ...(state.message ? { message: state.message } : {}) } : undefined;
  }

  forgetSignIn(threadId: string, name: string): void {
    const key = signInKey(threadId, name);
    this.answers.get(key)?.(undefined);
    this.signIns.delete(key);
  }

  async logout(threadId: string, name: string): Promise<McpActionResult> {
    await this.entry(threadId, name);
    const result = await this.sessions.mcpCommand(threadId, `logout ${name}`, { timeoutMs: ACTION_TIMEOUT_MS });
    return { message: lastMessage(result), overview: await this.overview(threadId) };
  }

  async reload(threadId: string): Promise<McpActionResult> {
    await this.threads.openSession(threadId);
    this.requireIdle(threadId, 'reload MCP servers');
    await this.sessions.reload(threadId);
    return { message: 'Reloaded the session; the servers connect again.', overview: await this.overview(threadId) };
  }

  // ---- MCP Apps

  /**
   * Answers one request of an MCP App (`forwardedProps.__proxiedMCPRequest`, the contract of
   * `@copilotkit/angular/mcp-apps`): `resources/read` of its `ui://` resource, `tools/call` of a tool of its
   * server, and the two notifications/pings the host forwards. The result is what goes into `RUN_FINISHED.result`.
   */
  async relay(threadId: string, request: ProxiedMcpRequest, signal?: AbortSignal): Promise<unknown> {
    if (!(PROXIED_MCP_METHODS as readonly string[]).includes(request.method)) throw new Error(`MCP method not allowed for UI proxy: ${request.method}`);
    if (request.method === 'ping') return {};
    if (!this.sessions.has(threadId)) await this.threads.openSession(threadId);
    const server = serverOf(request);
    const params = request.params ?? {};
    switch (request.method) {
      case 'resources/read': {
        const uri = String(params['uri'] ?? '');
        // An app loads its own user interface; other resources are the model's to read.
        if (!uri.startsWith('ui://')) throw new Error(`Only ui:// resources can be loaded for an MCP App, not "${uri}".`);
        return this.sessions.readMcpResource(threadId, server, uri, signal);
      }
      case 'tools/call': {
        const tool = String(params['name'] ?? '');
        if (!tool) throw new Error('tools/call needs a tool name.');
        if (!this.sessions.mcpAppMayCall(threadId, server, tool)) throw new Error(`The tool "${tool}" is not callable from an app (its _meta.ui.visibility leaves the app out).`);
        const args = params['arguments'];
        return this.sessions.callMcpTool(threadId, server, tool, args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}, signal);
      }
      default:
        // `notifications/message`: the app's log line. pi has nowhere to put it; accepting it keeps the app happy.
        return { success: true };
    }
  }

  // ---- internals

  private async status(threadId: string): Promise<McpStatusReport | undefined> {
    try {
      const result = await this.sessions.mcpCommand(threadId, '', { timeoutMs: STATUS_TIMEOUT_MS });
      const text = result.messages.map((m) => m.text).join('\n');
      // The command waits for every server to finish connecting; unfinished means some still are, and each
      // enabled server then shows as connecting (the panel asks again).
      return result.finished && text ? parseMcpStatus(text) : parseMcpStatus('');
    } catch {
      return undefined; // no /mcp command: MCP support is replaced or off
    }
  }

  private compose(config: ReturnType<typeof readMcpConfig>, report: McpStatusReport | undefined, projectTrusted: boolean, threadId?: string): McpOverview {
    const live = report !== undefined;
    const servers: McpServer[] = config.servers.map((entry) => {
      const status = report?.servers.get(entry.name);
      const server = toServer(entry, status, live);
      if (!threadId) return server;
      const signIn = server.state === 'connected' ? undefined : this.signInOf(threadId, entry.name);
      if (server.state === 'connected') this.signIns.delete(signInKey(threadId, entry.name));
      const toolList = server.state === 'connected' ? this.sessions.mcpTools(threadId, entry.name) : [];
      return { ...server, ...(signIn ? { signIn } : {}), ...(toolList.length > 0 ? { toolList } : {}) };
    });
    // Servers an extension registered for this session are not in any file.
    for (const [name, status] of report?.servers ?? []) {
      if (config.servers.some((e) => e.name === name)) continue;
      servers.push({
        name,
        scope: 'extension',
        source: 'a pi extension',
        transport: 'stdio',
        target: 'registered by an extension for this session',
        exposure: status.exposure,
        enabled: status.state !== 'disabled',
        state: status.state,
        ...(status.tools !== undefined ? { tools: status.tools } : {}),
        ...(status.error ? { error: status.error } : {}),
        oauth: status.state === 'needs-auth',
      });
    }
    return {
      servers,
      errors: [...config.errors, ...(report?.configErrors ?? [])],
      projectTrusted,
      live,
      userConfig: config.userConfig,
      ...(config.projectConfig ? { projectConfig: config.projectConfig } : {}),
    };
  }

  private async entry(threadId: string, name: string): Promise<McpConfigEntry> {
    const agentDir = await this.sessions.agentDir();
    await this.threads.openSession(threadId);
    const config = readMcpConfig({ agentDir, cwd: this.threads.cwdOf(threadId), projectTrusted: this.sessions.isProjectTrusted(threadId) });
    const entry = config.servers.find((e) => e.name === name);
    if (!entry) throw new NotFoundException(`No MCP server "${name}" is configured (servers an extension registered can only be changed from the extension).`);
    return entry;
  }

  private requireIdle(threadId: string, what: string): void {
    if (this.sessions.stats(threadId).streaming) throw new ConflictException(`Stop the run before you ${what}.`);
  }
}

function toServer(entry: McpConfigEntry, status: { state: McpState; tools?: number; error?: string; exposure: string } | undefined, live: boolean): McpServer {
  const state: McpState = !entry.enabled ? 'disabled' : (status?.state ?? (live ? 'connecting' : 'unknown'));
  return {
    name: entry.name,
    scope: entry.scope,
    source: entry.source,
    ...(entry.override ? { override: entry.override } : {}),
    transport: entry.transport,
    target: entry.target,
    ...(entry.description ? { description: entry.description } : {}),
    exposure: entry.exposure,
    enabled: entry.enabled,
    state,
    ...(status?.tools !== undefined ? { tools: status.tools } : {}),
    ...(status?.error && state !== 'connected' ? { error: status.error } : {}),
    oauth: entry.oauth,
  };
}

function lastMessage(result: { messages: { text: string }[]; failure?: string }): string | undefined {
  return result.failure ?? result.messages.at(-1)?.text;
}

/** The pi server a proxied request names: `serverId` is pi's server name; the hash is `pi-mcp:<name>`. */
function serverOf(request: ProxiedMcpRequest): string {
  const name = request.serverId ?? (request.serverHash.startsWith('pi-mcp:') ? request.serverHash.slice('pi-mcp:'.length) : '');
  if (!name) throw new BadRequestException(`Unknown MCP server: ${request.serverHash}`);
  return name;
}

/** A sign-in of this process; `url` is the fallback link while it waits, `message` is pi's own text when it did not succeed. */
interface SignInRun {
  phase: McpSignIn['phase'];
  url?: string;
  message?: string;
}

const signInKey = (threadId: string, name: string): string => `${threadId}\0${name}`;

/**
 * How a `/mcp login` ended, from what pi said (the SDK has no event for it, only the notifications of the command): "Signed in to MCP server ..." is success,
 * "Sign-in cancelled." is the person giving up, any other error is pi's reason (the authorization server refused, the page was denied, the code did not match), and a command
 * that ended without saying either (the session reloaded under it) is a sign-in that did not happen.
 */
export function signInOutcome(messages: readonly { text: string; level: string }[], failure?: string): 'done' | { phase: 'failed' | 'cancelled'; message?: string } {
  const last = messages.at(-1);
  if (failure) return { phase: 'failed', message: failure };
  if (!last) return { phase: 'cancelled' };
  if (last.text.startsWith('Signed in to MCP server')) return 'done';
  if (last.text === 'Sign-in cancelled.') return { phase: 'cancelled', message: last.text };
  if (last.level === 'error') return { phase: 'failed', message: last.text };
  return { phase: 'cancelled' };
}
