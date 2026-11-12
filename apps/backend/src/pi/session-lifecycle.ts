import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import type { AgentSession, BashOperations, EventBusController } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { type AgentsHook, createAgentTools } from '../bg-agents/agent-tools';
import { McpTap } from '../mcp/mcp-tap';
import { createAskUserExtension } from './ask-user-extension';
import { type BrowserHook, browserSkillPath, createBrowserExtension } from './browser-extension';
import { type CoordinationHook, createCoordinationExtension } from './coordination-extension';
import { createGenUiExtension, genUiSkillPath } from './genui-extension';
import { loadPi, loadPiMcp } from './load-pi';
import { createMcpTransport } from './mcp-transport';
import { createModelRuntime } from './model-runtime';
import type { PiPluginService } from './pi-plugin.service';
import { createPreviewExtension } from './preview-extension';
import { SessionMcp } from './session-mcp';
import { SessionQueue } from './session-queue';
import { createSessionUi, type SessionUiHooks } from './session-ui';
import type { TrustService } from './trust.service';
import type { UiBridge } from './ui-bridge';
import type { ThreadProtectionService } from './thread-protection.service';
import { ThreadProtectionExtension } from './thread-protection-extension';

export interface OpenTarget {
  cwd: string;
  sessionPath?: string;
  title?: string;
  /** The leaf the app had moved to (pi itself persists a leaf only by appending an entry); applied when it still exists. */
  leafId?: string;
  /** Open an existing session in `cwd` even when its file names another folder (a thread whose worktree was removed carries on in the project). */
  forceCwd?: boolean;
}

export interface PiThreadInfo {
  threadId: string;
  cwd: string;
  sessionId: string;
  /** Path of the JSONL session file; `pi --resume` in `cwd` lists it. */
  sessionFile: string | undefined;
  model: { provider: string; modelId: string } | undefined;
  thinkingLevel: string;
}

export interface OpenThread {
  session: AgentSession;
  /** What pi's MCP connections of this session told us. */
  tap: McpTap;
  mcp: SessionMcp;
  info: PiThreadInfo;
  /** Extension dialogs and fire-and-forget UI calls. */
  ui: UiBridge;
  /** pi's shared event bus of this session: extensions emit toolbar registrations on it (`pi-kit:composer`). */
  bus: EventBusController;
  /** The turn in flight, if any (`PiSessionService` keeps it): a prompt's promise, or one for a turn pi started by itself. It stays pending while an extension waits for an answer. */
  prompting?: Promise<void>;
  queue: SessionQueue;
  /** The `!command` shell of a sandboxed thread. */
  bash?: BashOperations;
}

interface LifecycleHooks {
  coordination(): CoordinationHook | undefined;
  browser(): BrowserHook | undefined;
  agents(): AgentsHook | undefined;
  ui(threadId: string, cwd: string): SessionUiHooks;
  /** A thread that is about to be registered: the facade follows its session's turns from here, before anyone can reach it. */
  opened(thread: OpenThread): void;
}

/** Session creation, open admission, ownership and shutdown for one backend. */
export class SessionLifecycle {
  private readonly logger = new Logger(SessionLifecycle.name);
  private readonly opened = new Map<string, OpenThread>();
  private readonly opening = new Map<string, Promise<OpenThread>>();
  private readonly epochs = new Map<string, number>();
  private destroyed = false;

  constructor(
    private readonly trust: TrustService,
    private readonly plugins: PiPluginService,
    private readonly hooks: LifecycleHooks,
    private readonly protection: ThreadProtectionService,
  ) {}

  get threads(): ReadonlyMap<string, OpenThread> {
    return this.opened;
  }

  get(threadId: string): OpenThread {
    const thread = this.opened.get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} is not open.`);
    return thread;
  }

  ensure(threadId: string, target: OpenTarget): Promise<OpenThread> {
    if (this.destroyed) return Promise.reject(new Error('The backend is shutting down.'));
    const open = this.opened.get(threadId);
    if (open) return Promise.resolve(open);
    let pending = this.opening.get(threadId);
    if (!pending) {
      // A failed open leaves no plugin binding behind: `create` binds the session before pi sets it up.
      pending = this.create(threadId, target)
        .catch((error: unknown) => {
          this.plugins.unbind(threadId);
          throw error;
        })
        .finally(() => this.opening.delete(threadId));
      this.opening.set(threadId, pending);
    }
    return pending;
  }

  dispose(threadId: string): void {
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1);
    const thread = this.opened.get(threadId);
    // Choosing Sandboxed starts the sandbox before any session opens; it is bound to the folder it started in.
    if (!thread) return this.releaseSandbox(threadId);
    this.opened.delete(threadId);
    this.release(thread);
  }

  close(): void {
    this.destroyed = true;
    for (const threadId of [...this.opened.keys()]) this.dispose(threadId);
  }

  private release(thread: OpenThread): void {
    // The session's plugin requests end first: what they started is aborted and their callers answered, before pi's session goes.
    this.plugins.unbind(thread.info.threadId);
    thread.ui.cancelAll();
    thread.ui.clearExtensions();
    thread.mcp.dispose();
    thread.session.dispose();
    thread.bus.clear();
    this.releaseSandbox(thread.info.threadId);
  }

  private releaseSandbox(threadId: string): void {
    void this.protection
      .release(`thread:${threadId}`)
      .catch((error: unknown) => this.logger.error(`Sandbox cleanup failed: ${String(error)}`));
  }

  private async create(threadId: string, target: OpenTarget): Promise<OpenThread> {
    this.protection.assertAdmitted(threadId);
    const { generation } = this.protection.binding(threadId);
    const admittedEpoch = this.epochs.get(threadId) ?? 0;
    const assertCurrent = (): void => {
      if ((this.epochs.get(threadId) ?? 0) !== admittedEpoch)
        throw new Error('The thread was closed or changed its protection while its session was opening.');
    };
    const pi = await loadPi();
    const existing = target.sessionPath && existsSync(target.sessionPath);
    const sessionManager = existing
      ? pi.SessionManager.open(target.sessionPath as string, undefined, target.forceCwd ? target.cwd : undefined)
      : pi.SessionManager.create(target.cwd, undefined, { id: threadId });
    if (!existing && target.title) sessionManager.appendSessionInfo(target.title);
    // The leaf the app moved to survives a restart only if the file has not changed since (the caller checks that).
    if (
      existing &&
      target.leafId &&
      target.leafId !== sessionManager.getLeafId() &&
      sessionManager.getEntry(target.leafId)
    ) {
      sessionManager.branch(target.leafId);
    }
    const cwd = sessionManager.getCwd();
    const agentDir = pi.getAgentDir();
    // A dispose during loadPi released the sandbox already; one started now would never be released.
    assertCurrent();
    const sandbox = await this.protection.prepare(threadId, cwd);
    const sandboxed = sandbox
      ? await ThreadProtectionExtension.create(pi, { threadId, cwd, client: sandbox, protection: this.protection })
      : undefined;
    // One settings manager for the loader and the session, so they agree on project trust. Trust is decided in
    // `reload()` below, before any project resource loads.
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    // Wraps pi's MCP transports so MCP Apps can learn which tools have a UI; one tap per session.
    const tap = new McpTap();
    const mcp = await loadPiMcp();
    const sessionUi = createSessionUi(pi, threadId, this.hooks.ui(threadId, cwd));
    const { ui, bus } = sessionUi;
    this.plugins.bind(threadId, bus);
    const resourceLoader = new pi.DefaultResourceLoader({
      additionalSkillPaths: [genUiSkillPath(), ...(this.hooks.browser()?.available ? [browserSkillPath()] : [])],
      cwd,
      agentDir,
      settingsManager,
      eventBus: bus,
      // The CLI loads these three as built-in extensions; SDK sessions have to ask for them.
      extensionFactories: [
        pi.createMcpExtension({
          // The end-to-end tests are their own browser (they open the authorization URL themselves); a person's machine gets pi's own launcher.
          ...(process.env['PI_KIT_NO_BROWSER'] === '1' ? { openUrl: () => undefined } : {}),
          createTransport: (entry, transportCwd, authProvider) => {
            this.protection.assertHostCapability(threadId, 'MCP servers');
            return tap.wrap(
              entry.name,
              createMcpTransport(mcp as never, entry as never, transportCwd, authProvider) as never,
            );
          },
        }),
        pi.createCodemodeExtension(),
        pi.createToolSearchExtension(),
        // Who else works here, and PI_KIT / PI_KIT_THREAD_ID for the shell.
        createCoordinationExtension(pi, {
          threadId,
          cwd,
          hook: () => this.hooks.coordination(),
          registerBash: !sandbox,
        }),
        createPreviewExtension({ publish: (registration) => ui.publishPreview(registration) }),
        createBrowserExtension({
          threadId,
          host: () => this.hooks.browser(),
          publish: (registration) => ui.announcePreview(registration),
        }),
        createAgentTools({ threadId, host: () => this.hooks.agents() }),
        createGenUiExtension(),
        createAskUserExtension(),
        ...(sandboxed ? [{ name: ThreadProtectionExtension.NAME, factory: sandboxed.factory, hidden: true }] : []),
      ],
    });
    await resourceLoader.reload({
      resolveProjectTrust: ({ extensionsResult }) => this.trust.resolveForOpen(cwd, extensionsResult),
    });
    const { session, modelFallbackMessage } = await pi.createAgentSession({
      modelRuntime: await createModelRuntime(pi),
      cwd,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    if (modelFallbackMessage) this.logger.warn(modelFallbackMessage);
    if (sandboxed) {
      const tools = session.getAllTools();
      const replaced = sandboxed.tools.filter(
        (name) => tools.find((tool) => tool.name === name)?.sourceInfo.path !== ThreadProtectionExtension.SOURCE,
      );
      if (replaced.length) {
        session.dispose();
        throw new Error(`Another extension replaced the sandboxed tools (${replaced.join(', ')}).`);
      }
    }
    await sessionUi.bind(session);
    try {
      assertCurrent();
      this.protection.assertGeneration(threadId, generation);
    } catch (error) {
      session.dispose();
      throw error;
    }
    const thread: OpenThread = {
      ui,
      bus,
      queue: new SessionQueue(session),
      tap,
      mcp: new SessionMcp(session, tap, () => this.protection.assertHostCapability(threadId, 'MCP App actions')),
      session,
      bash: sandboxed?.bash,
      info: {
        threadId,
        cwd,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        model: session.model && { provider: session.model.provider, modelId: session.model.id },
        thinkingLevel: session.thinkingLevel,
      },
    };
    if (this.destroyed) {
      this.release(thread);
      throw new Error('The backend is shutting down.');
    }
    this.hooks.opened(thread);
    this.opened.set(threadId, thread);
    this.logger.log(`Opened thread ${threadId} in ${cwd} (${session.sessionFile ?? 'no session file'})`);
    return thread;
  }
}
