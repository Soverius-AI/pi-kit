import { z } from 'zod';

export const PlaybookParticipantSchema = z
  .object({
    role: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .describe('A short role name, such as security or skeptic.'),
    agent: z
      .object({
        local: z.boolean().optional(),
        machine: z.string().min(1).max(200).optional(),
        agent: z.string().min(1).max(200).optional(),
      })
      .strict()
      .default({ local: true }),
    instructions: z.string().max(4000).default(''),
  })
  .strict()
  .meta({ id: 'PlaybookParticipant' });
export type PlaybookParticipant = z.infer<typeof PlaybookParticipantSchema>;

const ToolName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const TriggerId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const PlaybookMcpCallSchema = z
  .object({
    server: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(80)
      .describe('The MCP server, as it is named in the user’s mcp.json.'),
    tool: z.string().min(1).max(200).describe('The tool of that server to call.'),
    args: z.record(z.string(), z.unknown()).default({}).describe('The tool’s arguments; strings may hold {param}.'),
  })
  .strict()
  .meta({ id: 'PlaybookMcpCall' });
export type PlaybookMcpCall = z.infer<typeof PlaybookMcpCallSchema>;

export const PlaybookMailSourceSchema = z
  .object({
    mailbox: z.string().min(1).max(200).default('inbox').describe('A mailbox of Mail on this computer.'),
    unread: z.boolean().default(false).describe('Only unread messages.'),
    limit: z.number().int().min(1).max(50).default(20).describe('The newest messages, at most this many.'),
    launch: z.boolean().default(false).describe('Open Mail when it is not running.'),
  })
  .strict()
  .meta({ id: 'PlaybookMailSource' });
export type PlaybookMailSource = z.infer<typeof PlaybookMailSourceSchema>;

export const PlaybookCalendarSourceSchema = z
  .object({
    days: z.number().int().min(1).max(31).default(1).describe('Events from now until this many days ahead.'),
    ics: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('An iCalendar URL or file instead of the calendars of this computer; may hold {param} and ${ENV}.'),
  })
  .strict()
  .meta({ id: 'PlaybookCalendarSource' });
export type PlaybookCalendarSource = z.infer<typeof PlaybookCalendarSourceSchema>;

const ToolFields = {
  run: z.array(z.string().max(2000)).min(1).max(64).optional(),
  mcp: PlaybookMcpCallSchema.optional(),
  mail: PlaybookMailSourceSchema.optional(),
  calendar: PlaybookCalendarSourceSchema.optional(),
  description: z.string().max(1000).default(''),
};
const oneKind = (tool: { run?: unknown; mcp?: unknown; mail?: unknown; calendar?: unknown }) =>
  [tool.run, tool.mcp, tool.mail, tool.calendar].filter((kind) => kind !== undefined).length === 1;
const ONE_KIND = { message: 'A tool has exactly one of run, mcp, mail or calendar.' };

export const PlaybookToolSchema = z.object(ToolFields).strict().refine(oneKind, ONE_KIND).meta({ id: 'PlaybookTool' });
export type PlaybookTool = z.infer<typeof PlaybookToolSchema>;

export const PlaybookSafeOutputSchema = z
  .object({
    ...ToolFields,
    mode: z.enum(['draft', 'auto']).default('draft').describe('draft: the owner approves each call; auto: it runs.'),
    max: z.number().int().min(1).max(1000).optional().describe('At most this many calls a day.'),
  })
  .strict()
  .refine(oneKind, ONE_KIND)
  .meta({ id: 'PlaybookSafeOutput' });
export type PlaybookSafeOutput = z.infer<typeof PlaybookSafeOutputSchema>;

const Every = z.string().regex(/^\d+(s|m|h|d)$/);

export const PlaybookScheduleSchema = z
  .object({
    id: TriggerId,
    every: Every.optional(),
    cron: z
      .string()
      .regex(/^\S+( \S+){4}$/)
      .optional()
      .describe('Five cron fields in this computer’s time zone, such as 0 8 * * 1-5.'),
    say: z.string().max(2000).default(''),
  })
  .strict()
  .refine((schedule) => !!schedule.every !== !!schedule.cron, { message: 'A schedule has either every or cron.' })
  .meta({ id: 'PlaybookSchedule' });
export type PlaybookSchedule = z.infer<typeof PlaybookScheduleSchema>;

export const PlaybookPollSchema = z
  .object({
    id: TriggerId,
    tool: ToolName,
    every: Every,
    with: z.record(z.string(), z.string()).default({}),
    key: z.array(z.string().min(1).max(200)).min(1).max(8).optional(),
    say: z.string().max(2000).default(''),
  })
  .strict()
  .meta({ id: 'PlaybookPoll' });
export type PlaybookPoll = z.infer<typeof PlaybookPollSchema>;

export const PlaybookConfigSchema = z
  .object({
    participants: z.array(PlaybookParticipantSchema).max(8).default([]),
    tools: z.record(ToolName, PlaybookToolSchema).default({}),
    'safe-outputs': z.record(ToolName, PlaybookSafeOutputSchema).default({}),
    vars: z.record(z.string(), z.string()).default({}),
    on: z
      .object({
        schedule: z.array(PlaybookScheduleSchema).max(8).default([]),
        poll: z.array(PlaybookPollSchema).max(8).default([]),
      })
      .strict()
      .default({ schedule: [], poll: [] }),
    stages: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
      .max(12)
      .default([]),
    gates: z.record(z.string(), z.enum(['owner', 'lead'])).default({}),
  })
  .strict()
  .meta({ id: 'PlaybookConfig' });
export type PlaybookConfig = z.infer<typeof PlaybookConfigSchema>;

export const PlaybookSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
    roles: z.array(z.string()),
    tools: z.array(z.string()),
    outputs: z.array(z.string()),
    triggers: z.number().int().nonnegative(),
    stages: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'PlaybookSummary' });
export type PlaybookSummary = z.infer<typeof PlaybookSummarySchema>;
export const PlaybookListSchema = z.array(PlaybookSummarySchema).meta({ id: 'PlaybookList' });

export const PlaybooksQuerySchema = z
  .object({
    repository: z.string().min(1).max(512),
    baseCommit: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    threadId: z.string().max(512).optional(),
  })
  .strict();

export const RoomActionSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['call', 'advance']),
    name: z.string(),
    summary: z.string(),
    payload: z.record(z.string(), z.unknown()),
    state: z.enum(['pending', 'done', 'failed', 'discarded']),
    result: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .meta({ id: 'RoomAction' });
export type RoomAction = z.infer<typeof RoomActionSchema>;

export const RoomActionDecisionSchema = z
  .object({ decision: z.enum(['approve', 'discard']) })
  .strict()
  .meta({ id: 'RoomActionDecision' });
export type RoomActionDecision = z.infer<typeof RoomActionDecisionSchema>;

export const RoomMemoryEntrySchema = z
  .object({
    scope: z.enum(['room', 'playbook']),
    key: z.string(),
    text: z.string(),
    updatedBy: z.string(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'RoomMemoryEntry' });
export type RoomMemoryEntry = z.infer<typeof RoomMemoryEntrySchema>;
