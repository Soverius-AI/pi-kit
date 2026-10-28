import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/core';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { isAborted, isInterrupt } from '@pi-kit/pi-adapter';
import type { ComposerChip } from '@pi-kit/protocol';
import { CONFIG } from '../app/config.token';
import type { BackendConfig } from '../app/config';
import { ChangesRepository } from '../db/changes.repository';
import { McpService } from '../mcp/mcp.service';
import { BgAgent } from '../bg-agents/bg-agent-runner';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { PiAgent } from './pi-agent';
import { PiAgentRunner } from './pi-agent-runner';

/** How a run that no browser started ended (`AguiService.runHeadless`). `interrupted`: pi stopped to ask the person a question nobody is there to answer. */
export interface HeadlessRun {
  status: 'finished' | 'aborted' | 'error' | 'interrupted';
  error?: string;
}

/** `(Request) => Response` handler of CopilotKit's runtime with pi registered as agent `pi`. */
@Injectable()
export class AguiService {
  /** Path the renderer's `runtimeUrl` points at; the Nest global prefix is `api`. */
  static readonly BASE_PATH = '/api/copilotkit';

  readonly handle: (request: Request) => Promise<Response>;
  private readonly agent: PiAgent;

  constructor(
    sessions: PiSessionService,
    threads: ThreadsService,
    private readonly runner: PiAgentRunner,
    mcp: McpService,
    changes: ChangesRepository,
    @Inject(CONFIG) config: BackendConfig,
  ) {
    this.agent = new PiAgent(sessions, {
      defaultCwd: config.defaultCwd,
      threads,
      carry: new Map(),
      relayMcp: (threadId, request, signal) => mcp.relay(threadId, request, signal),
      reviewRecorded: (threadId) => changes.clearComments(threadId),
      beforePrompt: (threadId) => runner.beforePrompt(threadId),
    });
    // Turns pi starts by itself run through the same agent, so they stream and replay like any other.
    runner.useAgent(() => this.agent.clone());
    const runtime = new CopilotRuntime({
      // `pi-bg` is a background agent's transcript; the runner hands its requests to `BgAgentRunner`.
      agents: { pi: this.agent, 'pi-bg': new BgAgent() },
      // Durable threads: runs, replay and stop go through our runner, not the in-memory one.
      runner,
      // A2UI: advertised to the browser so it mounts the A2UI renderer, and the middleware turns a click on
      // a surface into the message pair PiAgent prompts with. pi owns its render_a2ui tool and bundled skill;
      // frontend-injected tools are not forwarded to pi. Surfaces come from tool results (`a2ui_operations`).
      a2ui: { agents: ['pi'], injectA2UITool: false },
      // pi registers generateSandboxedUi itself; CopilotKit transforms its argument stream into UI activities.
      openGenerativeUI: { agents: ['pi'] },
    });
    // No `cors` option: Nest's CORS middleware (origin list from PI_KIT_ORIGIN) answers first, and a
    // second layer would add duplicate headers. Auth is the global bearer guard.
    this.handle = createCopilotRuntimeHandler({ runtime, basePath: AguiService.BASE_PATH });
  }

  /**
   * A run of the thread that no browser started (a verification replays a skill in a scratch worktree). It takes the same road as a run from the composer
   * (the runner's lock and log, the status stream, the skill chips), so the thread is a normal thread while it works: visible and stoppable. Resolves when the run is over.
   */
  runHeadless(
    threadId: string,
    text: string,
    options: { cwd: string; chips?: readonly ComposerChip[] },
  ): Promise<HeadlessRun> {
    const runId = `headless-${randomUUID()}`;
    const input: RunAgentInput = {
      threadId,
      runId,
      state: {},
      messages: [{ id: randomUUID(), role: 'user', content: text }],
      tools: [],
      context: [],
      forwardedProps: {
        cwd: options.cwd,
        ...(options.chips && options.chips.length > 0 ? { skills: options.chips } : {}),
      },
    };
    return new Promise<HeadlessRun>((resolve) => {
      let result: HeadlessRun = { status: 'error', error: 'The run ended without a result.' };
      const note = (event: BaseEvent): void => {
        if (event.type === EventType.RUN_ERROR) {
          result = isAborted(event)
            ? { status: 'aborted' }
            : { status: 'error', error: String((event as { message?: unknown }).message ?? 'The run failed.') };
        } else if (event.type === EventType.RUN_FINISHED) {
          result = isInterrupt(event)
            ? { status: 'interrupted' }
            : isAborted(event)
              ? { status: 'aborted' }
              : { status: 'finished' };
        }
      };
      try {
        this.runner.run({ threadId, agent: this.agent.clone(), input }).subscribe({
          next: note,
          error: (error: unknown) =>
            resolve({ status: 'error', error: error instanceof Error ? error.message : String(error) }),
          complete: () => resolve(result),
        });
      } catch (error) {
        resolve({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
