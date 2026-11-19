import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { z } from 'zod';

export interface RoomToolsHook {
  propose(threadId: string, task: { title: string; brief: string; acceptance: string }): Promise<string>;
  answer(threadId: string, input: { taskId: string; answer: string }): Promise<string>;
  escalate(threadId: string, input: { taskId: string; reason: string }): Promise<string>;
  accept(threadId: string, input: { taskId: string; note: string }): Promise<string>;
  requestChanges(threadId: string, input: { taskId: string; feedback: string }): Promise<string>;
}

export class RoomTools {
  static readonly NAME = 'room-tools';
  static readonly PROPOSE = 'room_propose_task';
  static readonly ANSWER = 'room_answer';
  static readonly ESCALATE = 'room_escalate';
  static readonly ACCEPT = 'room_accept';
  static readonly REQUEST_CHANGES = 'room_request_changes';
  static readonly NAMES = [
    RoomTools.PROPOSE,
    RoomTools.ANSWER,
    RoomTools.ESCALATE,
    RoomTools.ACCEPT,
    RoomTools.REQUEST_CHANGES,
  ] as const;
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
    };
  }
}
