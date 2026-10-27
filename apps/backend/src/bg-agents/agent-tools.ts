import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { PiDialogAnswer } from '@pi-kit/protocol';
import { z } from 'zod';
import type { AgentPermission, AgentStatus, BgAgentRow } from './bg-agents.repository';

/** The key of the main agent's system-prompt section; pi wraps it as `<background_agents>…</background_agents>`. */
export const AGENTS_SECTION = 'background_agents';
export const SPAWN_TOOL = 'agent_spawn';

/** What the main agent's tools ask of the backend; `BgAgentsService` implements it, like `BrowserHook`. */
export interface AgentsHook {
  /** False while background agents are off (they have not started, another backend owns the store, the store or the model runtime failed to open, the backend is shutting down). */
  available(threadId: string): boolean;
  spawn(input: { threadId: string; name: string; role: string; brief: string; permission: AgentPermission; model?: string }): Promise<BgAgentRow>;
  send(agentId: string, text: string, mode: 'steer' | 'followUp', requestId: string): Promise<void>;
  list(threadId: string): BgAgentRow[];
  /** Waits for the agent's run to end or the caller to cancel; the status afterwards. */
  wait(agentId: string, signal?: AbortSignal): Promise<AgentStatus>;
  stop(agentId: string): Promise<void>;
  /** The main agent's answer to a `main` question. */
  reply(agentId: string, questionId: string, text: string): Promise<void>;
  /** The main agent hands a `main` question to the user, with a note or not. */
  forward(agentId: string, questionId: string, note?: string): Promise<void>;
  /** The user's answer to a question (an AG-UI resume with the question's interrupt id, or a chip); false if the id is not an agent's question. */
  answerInterrupt(interruptId: string, answer: PiDialogAnswer | 'cancelled'): Promise<boolean>;
}

const SpawnSchema = z
  .object({
    name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes').describe('A short name, unique in this thread: tester, reviewer, docs.'),
    role: z.string().min(1).max(80).describe('One phrase: what this agent is for.'),
    brief: z.string().min(1).describe('The task: what to do, when it is done, the paths that matter. The agent does not see this conversation.'),
    permission: z.enum(['read-only', 'edit', 'isolated']).default('read-only').describe('read-only (default): read and run read-only commands. edit: write in this folder. isolated: its own worktree.'),
    model: z.string().optional().describe('provider/modelId; omit for this thread\'s model.'),
  })
  .strict();
const SendSchema = z.object({ agent: z.string().min(1).describe('The agent id from agent_spawn or agent_list.'), text: z.string().min(1), mode: z.enum(['steer', 'followUp']).default('followUp') }).strict();
const AgentSchema = z.object({ agent: z.string().min(1) }).strict();
const ReplySchema = z.object({ agent: z.string().min(1), question: z.string().min(1).describe('The question id from the agent\'s message.'), text: z.string().min(1) }).strict();
const ForwardSchema = z.object({ agent: z.string().min(1), question: z.string().min(1), note: z.string().optional().describe('What the user should know to decide.') }).strict();

const GUIDANCE = `You can delegate self-contained side tasks to background agents with agent_spawn: a test sweep, a review, a docs update, a refactor of another module. An agent runs on its own, in this project's folder, with read, write, edit and bash, and does not see this conversation: write a complete brief (the task, what done means, the paths that matter). It reports back by itself when it is done; the report arrives here as a message from the agent, so do not wait or poll for it. Use agent_send to add to its task, agent_list to see what runs, agent_stop to end one, and agent_wait only when you need the result before you can go on. Keep doing your own part meanwhile. An agent may ask you a question (a message "Question from agent …" with a question id): answer it with agent_reply when you know, or hand it to the user with agent_forward when it is their call (preferences, credentials, anything destructive). Questions an agent asked the user directly are not yours to answer.`;

const params = (schema: z.ZodType): ToolDefinition['parameters'] => z.toJSONSchema(schema, { target: 'draft-7' }) as unknown as ToolDefinition['parameters'];
const text = (value: unknown): { content: { type: 'text'; text: string }[]; details: Record<string, unknown> } => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
const summary = (row: BgAgentRow) => ({ agentId: row.id, name: row.name, role: row.role, permission: row.permission, status: row.status, ...(row.report ? { report: row.report } : {}) });

/**
 * The pi extension every main session runs with (like the browser extension): `agent_spawn`, `agent_send`, `agent_list`,
 * `agent_wait`, `agent_stop`, `agent_reply`, `agent_forward`, and a short system-prompt section on when to delegate.
 * Tools are registered even while agents are off, so the model gets a clear error instead of a missing tool; the section says nothing then.
 */
export function createAgentTools(options: { threadId: string; host: () => AgentsHook | undefined }): ExtensionFactory {
  const { threadId } = options;
  const host = (): AgentsHook => {
    const hook = options.host();
    if (!hook?.available(threadId)) throw new Error('Background agents are not available in this backend: another pi-kit owns them, their store or the model runtime failed to open, or the backend is shutting down.');
    return hook;
  };
  return (api: ExtensionAPI) => {
    api.registerTool({
      name: SPAWN_TOOL,
      label: 'Spawn agent',
      description: 'Start a background agent for a self-contained task in this project: name, role, a complete brief, a permission mode. It reports back by itself when done.',
      promptSnippet: 'Delegate a self-contained side task to a background agent that reports back when done.',
      parameters: params(SpawnSchema),
      executionMode: 'sequential',
      async execute(_id, input, _signal, _update, ctx) {
        const parsed = SpawnSchema.parse(input);
        const model = parsed.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
        const row = await host().spawn({ threadId, ...parsed, model });
        return { content: text(summary(row)).content, details: { agentId: row.id, name: row.name, role: row.role, permission: row.permission } };
      },
    });
    api.registerTool({
      name: 'agent_send',
      label: 'Message agent',
      description: 'Send a background agent of this thread more instructions: a steer (now, mid-task) or a follow-up (after its current task).',
      parameters: params(SendSchema),
      executionMode: 'sequential',
      async execute(id, input) {
        const parsed = SendSchema.parse(input);
        await host().send(parsed.agent, parsed.text, parsed.mode, `send:${id}`);
        return text(`Sent to agent ${parsed.agent} as ${parsed.mode}.`);
      },
    });
    api.registerTool({
      name: 'agent_list',
      label: 'List agents',
      description: 'The background agents of this thread with their status and, when done, their report.',
      parameters: params(z.object({}).strict()),
      async execute() {
        return text(host().list(threadId).map(summary));
      },
    });
    api.registerTool({
      name: 'agent_wait',
      label: 'Wait for agent',
      description: 'Wait for a background agent to finish; returns its final status. Reports arrive by themselves, so use this only when you need the result before you can go on.',
      parameters: params(AgentSchema),
      executionMode: 'sequential',
      async execute(_id, input, signal) {
        const parsed = AgentSchema.parse(input);
        // Stop ends the wait with the run: pi aborts the tool through its signal, which the wait must honour at once.
        let onAbort: (() => void) | undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('Stopped while waiting for the agent.'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
        try {
          return text({ agentId: parsed.agent, status: await Promise.race([host().wait(parsed.agent, signal), stopped]) });
        } finally {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
      },
    });
    api.registerTool({
      name: 'agent_stop',
      label: 'Stop agent',
      description: 'Stop a background agent of this thread; it keeps what it did so far.',
      parameters: params(AgentSchema),
      executionMode: 'sequential',
      async execute(_id, input) {
        const parsed = AgentSchema.parse(input);
        await host().stop(parsed.agent);
        return text(`Agent ${parsed.agent} stopped.`);
      },
    });
    api.registerTool({
      name: 'agent_reply',
      label: 'Answer agent',
      description: 'Answer a question a background agent asked you (the question id is in its message).',
      parameters: params(ReplySchema),
      executionMode: 'sequential',
      async execute(_id, input) {
        const parsed = ReplySchema.parse(input);
        await host().reply(parsed.agent, parsed.question, parsed.text);
        return text(`Answered question ${parsed.question} of agent ${parsed.agent}.`);
      },
    });
    api.registerTool({
      name: 'agent_forward',
      label: 'Forward question',
      description: "Hand a background agent's question to the user, when it is their call; add a note on what they should know.",
      parameters: params(ForwardSchema),
      executionMode: 'sequential',
      async execute(_id, input) {
        const parsed = ForwardSchema.parse(input);
        await host().forward(parsed.agent, parsed.question, parsed.note);
        return text(`Question ${parsed.question} of agent ${parsed.agent} is now the user's; you get a receipt when they answered.`);
      },
    });
    api.on('before_agent_start', (event) => {
      if (options.host()?.available(threadId) && api.getActiveTools().includes(SPAWN_TOOL)) event.systemPromptOptions.sections[AGENTS_SECTION] = GUIDANCE;
      else delete event.systemPromptOptions.sections[AGENTS_SECTION];
    });
  };
}
