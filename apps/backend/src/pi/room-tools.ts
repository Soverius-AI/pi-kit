import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface RoomToolsHook {
  propose(threadId: string, task: { title: string; brief: string; acceptance: string }): Promise<string>;
  answer(threadId: string, input: { taskId: string; answer: string }): Promise<string>;
  escalate(threadId: string, input: { taskId: string; reason: string }): Promise<string>;
  accept(threadId: string, input: { taskId: string; note: string }): Promise<string>;
  requestChanges(threadId: string, input: { taskId: string; feedback: string }): Promise<string>;
  call(
    threadId: string,
    input: { tool: string; params: Record<string, string>; reason: string; page?: number },
  ): Promise<string>;
  consult(threadId: string, input: { role: string; question: string }): Promise<string>;
  discuss(threadId: string, input: { question: string; roles?: string[] }): Promise<string>;
  note(threadId: string, input: { key: string; text: string; scope: 'room' | 'playbook' }): Promise<string>;
  advance(threadId: string, input: { stage: string; summary: string }): Promise<string>;
  proposePlaybook(
    threadId: string,
    input: { name: string; skill: string; yaml: string; summary: string },
  ): Promise<string>;
  /** An MCP tool's whole result; the session file keeps only its text, which is not enough for an MCP App. */
  mcpResult(threadId: string, toolCallId: string, result: Record<string, unknown>): void;
}

export class RoomTools {
  static readonly NAME = 'room-tools';
  static readonly PROPOSE = 'room_propose_task';
  static readonly ANSWER = 'room_answer';
  static readonly ESCALATE = 'room_escalate';
  static readonly ACCEPT = 'room_accept';
  static readonly REQUEST_CHANGES = 'room_request_changes';
  static readonly CALL = 'room_call';
  static readonly CONSULT = 'room_consult';
  static readonly DISCUSS = 'room_discuss';
  static readonly NOTE = 'room_note';
  static readonly ADVANCE = 'room_advance';
  static readonly GUIDE = 'room_playbook_guide';
  static readonly PROPOSE_PLAYBOOK = 'room_playbook_propose';
  static readonly NAMES = [
    RoomTools.PROPOSE,
    RoomTools.ANSWER,
    RoomTools.ESCALATE,
    RoomTools.ACCEPT,
    RoomTools.REQUEST_CHANGES,
    RoomTools.CALL,
    RoomTools.CONSULT,
    RoomTools.DISCUSS,
    RoomTools.NOTE,
    RoomTools.ADVANCE,
    RoomTools.GUIDE,
    RoomTools.PROPOSE_PLAYBOOK,
  ] as const;
  private static readonly Role = z.string().trim().min(1).max(40).describe('A participant role the playbook names.');
  private static readonly CallSchema = z
    .object({
      tool: z.string().trim().min(1).max(80).describe('The tool or safe output, as the playbook names it.'),
      params: z.record(z.string(), z.string().max(4000)).default({}).describe('Values for its parameters, by name.'),
      reason: z.string().trim().min(1).max(1000).describe('Why you call it, in one sentence for the owner.'),
      page: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('A later page of a long output, as the end of the previous page says; the first page when left out.'),
    })
    .strict();
  private static readonly ConsultSchema = z
    .object({
      role: RoomTools.Role,
      question: z
        .string()
        .trim()
        .min(1)
        .max(32000)
        .describe('A complete question: the participant sees nothing else of the room, so include what it needs.'),
    })
    .strict();
  private static readonly DiscussSchema = z
    .object({
      question: z.string().trim().min(1).max(32000).describe('The question every participant answers, complete.'),
      roles: z.array(RoomTools.Role).max(8).optional().describe('Whom to ask; all participants when left out.'),
    })
    .strict();
  private static readonly NoteSchema = z
    .object({
      key: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe('A short name for the note, such as spec, decision or reviewed-prs. The same key replaces it.'),
      text: z.string().max(8000).describe('The note; empty forgets it.'),
      scope: z
        .enum(['room', 'playbook'])
        .default('room')
        .describe('room for this room only; playbook to carry it to later rooms of this playbook.'),
    })
    .strict();
  private static readonly AdvanceSchema = z
    .object({
      stage: z.string().trim().min(1).max(40).describe('The stage to move to, as the playbook names it.'),
      summary: z.string().trim().min(1).max(2000).describe('Why the room is ready for it, for the owner.'),
    })
    .strict();
  private static readonly ProposePlaybookSchema = z
    .object({
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .describe('The playbook’s name: its folder under .pi/skills and the name in its front matter.'),
      skill: z
        .string()
        .min(1)
        .max(64 * 1024)
        .describe('The whole new SKILL.md, front matter included.'),
      yaml: z
        .string()
        .max(64 * 1024)
        .describe('The whole new room.yaml.'),
      summary: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe('What the change does, in one or two sentences for the owner.'),
    })
    .strict();
  private static readonly TaskId = z.string().uuid().describe('The id of the task, as the room message gave it.');
  private static readonly AnswerSchema = z
    .object({
      taskId: RoomTools.TaskId,
      answer: z
        .string()
        .trim()
        .min(1)
        .max(8000)
        .describe(
          'The answer to the worker’s open question: for a yes/no question "yes" or "no", for a choice the option, else the text.',
        ),
    })
    .strict();
  private static readonly EscalateSchema = z
    .object({
      taskId: RoomTools.TaskId,
      reason: z.string().trim().min(1).max(2000).describe('Why the owner should answer this, in one or two sentences.'),
    })
    .strict();
  private static readonly AcceptSchema = z
    .object({
      taskId: RoomTools.TaskId,
      note: z.string().trim().max(2000).describe('What you checked, in one or two sentences, for the owner.'),
    })
    .strict();
  private static readonly ChangesSchema = z
    .object({
      taskId: RoomTools.TaskId,
      feedback: z
        .string()
        .trim()
        .min(1)
        .max(8000)
        .describe('What the worker must change to meet the acceptance criteria: concrete and complete.'),
    })
    .strict();
  private static readonly ProposeSchema = z
    .object({
      title: z.string().trim().min(1).max(200).describe('A short title for the task, in the imperative.'),
      brief: z
        .string()
        .trim()
        .min(1)
        .max(8000)
        .describe('Everything a worker needs: the goal, where to look, what to change and what to leave alone.'),
      acceptance: z
        .string()
        .trim()
        .max(4000)
        .describe('How the owner can tell the task is done, for example which tests must pass.'),
    })
    .strict();

  static skillPath(): string | undefined {
    return [
      join(__dirname, 'assets', 'skills', 'pi-room-playbook', 'SKILL.md'),
      join(__dirname, '..', 'assets', 'skills', 'pi-room-playbook', 'SKILL.md'),
    ].find((path) => existsSync(path));
  }

  static factory(threadId: string, host: () => RoomToolsHook | undefined): ExtensionFactory {
    const hook = (): RoomToolsHook => {
      const value = host();
      if (!value) throw new Error('Rooms are not available in this backend.');
      return value;
    };
    const tool = <T>(
      name: string,
      label: string,
      description: string,
      schema: z.ZodType<T>,
      run: (input: T) => Promise<string>,
    ) => ({
      name,
      label,
      description,
      parameters: z.toJSONSchema(schema, { target: 'draft-7' }) as unknown as ToolDefinition['parameters'],
      executionMode: 'sequential' as const,
      async execute(_id: string, input: unknown) {
        const text = await run(schema.parse(input));
        return { content: [{ type: 'text' as const, text }], details: {} };
      },
    });
    return (api: ExtensionAPI) => {
      api.on('tool_result', (event) => {
        const result = event.structuredContent;
        if (!('toolName' in event) || !event.toolName.startsWith('mcp__') || !result || typeof result !== 'object')
          return;
        const call = result as Record<string, unknown>;
        if (Array.isArray(call['content'])) host()?.mcpResult(threadId, event.toolCallId, call);
      });
      api.registerTool({
        ...tool(
          RoomTools.PROPOSE,
          'Propose a task',
          'Propose a task for a worker in this room: a title, a complete brief and acceptance criteria. The owner approves it before a worker runs it in its own worktree at the room’s base commit; the result comes back to the room.',
          RoomTools.ProposeSchema,
          (input) => hook().propose(threadId, input),
        ),
        promptSnippet: 'Hand a self-contained piece of work to a room worker; the owner approves it first.',
      });
      api.registerTool(
        tool(
          RoomTools.ANSWER,
          'Answer a worker',
          'Answer the open question of a running worker in this room. Answer only from what you know (the room’s summary, the repository, earlier messages); escalate when the owner must decide.',
          RoomTools.AnswerSchema,
          (input) => hook().answer(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.ESCALATE,
          'Hand a question to the owner',
          'Leave a worker’s open question to the owner, with the reason. Use it for anything risky, outside the task, about secrets or credentials, or when you are not sure.',
          RoomTools.EscalateSchema,
          (input) => hook().escalate(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.ACCEPT,
          'Accept a result',
          'Accept a submitted task after reviewing its diff against the acceptance criteria. The owner still decides whether to integrate it.',
          RoomTools.AcceptSchema,
          (input) => hook().accept(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.REQUEST_CHANGES,
          'Request changes',
          'Send a submitted task back to its worker with what must change. The worker continues from its own commit in a new attempt.',
          RoomTools.ChangesSchema,
          (input) => hook().requestChanges(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.CALL,
          'Call a playbook tool',
          'Run one of the playbook’s tools or safe outputs. Tools only read and run at once, returning their output a page at a time when it is long; safe outputs write and become a draft the owner approves, unless the playbook runs them at once.',
          RoomTools.CallSchema,
          (input) => hook().call(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.CONSULT,
          'Consult a participant',
          'Ask one participant of the playbook (a role, possibly on another computer) and get its answer. It keeps its own conversation across questions in this room.',
          RoomTools.ConsultSchema,
          (input) => hook().consult(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.DISCUSS,
          'Discuss with participants',
          'Ask several participants the same question at once and get every answer, to weigh and decide on.',
          RoomTools.DiscussSchema,
          (input) => hook().discuss(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.NOTE,
          'Keep a note',
          'Write or replace a note in the room’s notebook: a decision, the current spec, what was reviewed. The owner sees the notebook.',
          RoomTools.NoteSchema,
          (input) => hook().note(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.ADVANCE,
          'Move to a stage',
          'Move the room to another stage of the playbook. A stage the owner gates waits for their approval.',
          RoomTools.AdvanceSchema,
          (input) => hook().advance(threadId, input),
        ),
      );
      api.registerTool(
        tool(
          RoomTools.PROPOSE_PLAYBOOK,
          'Propose a playbook',
          'Propose a new room playbook or a change to one: both whole files. pi-kit checks them the way it loads a playbook and returns the errors to fix. A valid proposal shows the owner its diff; once they apply it, it is written into the project folder and the room follows it.',
          RoomTools.ProposePlaybookSchema,
          (input) => hook().proposePlaybook(threadId, input),
        ),
      );
      const guide = RoomTools.skillPath();
      if (guide)
        api.registerTool(
          tool(
            RoomTools.GUIDE,
            'Read the playbook guide',
            'The guide to writing pi-kit room playbooks: room.yaml with its participants, tools, safe outputs, triggers, stages and gates. Read it before you write or change a playbook; in a read-only room it replaces reading the pi-room-playbook skill file.',
            z.object({}).strict(),
            async () => readFileSync(guide, 'utf8'),
          ),
        );
    };
  }
}
