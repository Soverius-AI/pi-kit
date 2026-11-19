import { z } from 'zod';
import { InstanceIdSchema } from './environments';
import { PiDialogMethodSchema } from './interrupts';

export const RoomIdSchema = z.uuid();

export const RoomSchema = z
  .object({
    id: RoomIdSchema,
    title: z.string().min(1).max(200),
    repository: z.string().min(1).max(512),
    hostInstanceId: InstanceIdSchema,
    baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    waiting: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'Room' });
export type Room = z.infer<typeof RoomSchema>;

export const RoomListSchema = z.array(RoomSchema).meta({ id: 'RoomList' });

export const RoomStartQuerySchema = z.object({ threadId: z.string().min(1).max(512) }).strict();

export const RoomStartPreviewSchema = z
  .object({
    title: z.string().max(200),
    repository: z.string().min(1).max(512),
    branch: z.string().nullable(),
    baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    uncommittedFiles: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'RoomStartPreview' });
export type RoomStartPreview = z.infer<typeof RoomStartPreviewSchema>;

export const CreateRoomSchema = z
  .object({
    threadId: z.string().min(1).max(512).optional(),
    repository: z.string().min(1).max(512).optional(),
    baseCommit: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(4000),
    projectFolder: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine((input) => !!input.threadId || (!!input.repository && !!input.baseCommit), {
    message: 'Start a room from a thread, or give the repository and base commit.',
  })
  .meta({ id: 'CreateRoom' });
export type CreateRoom = z.infer<typeof CreateRoomSchema>;

export const RoomCloneSchema = z.object({ folder: z.string(), clean: z.boolean() }).strict().meta({ id: 'RoomClone' });
export type RoomClone = z.infer<typeof RoomCloneSchema>;
export const RoomCloneListSchema = z.array(RoomCloneSchema).meta({ id: 'RoomCloneList' });

export const RoomClonesQuerySchema = z
  .object({
    repository: z.string().min(1).max(512),
    baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  })
  .strict();

export const ROOMS_SETTING_KEY = 'collaboration.rooms';

export const RoomEventSchema = z
  .object({
    roomId: RoomIdSchema,
    seq: z.number().int().positive(),
    kind: z.enum(['message', 'note', 'task']),
    actor: z.enum(['owner', 'lead', 'coordinator', 'worker']),
    text: z.string().max(32000),
    images: z.number().int().nonnegative(),
    taskId: z.string().nullable(),
    environmentId: z.string().nullable().optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'RoomEvent' });
export type RoomEvent = z.infer<typeof RoomEventSchema>;

export const RoomModeSchema = z.enum(['supervised', 'assisted']).meta({ id: 'RoomMode' });
export type RoomMode = z.infer<typeof RoomModeSchema>;

export const RoomLeadStateSchema = z.enum(['idle', 'working', 'error']).meta({ id: 'RoomLeadState' });
export type RoomLeadState = z.infer<typeof RoomLeadStateSchema>;

export const RoomTaskStateSchema = z
  .enum(['proposed', 'declined', 'running', 'submitted', 'failed', 'stopped', 'integrated'])
  .meta({ id: 'RoomTaskState' });
export type RoomTaskState = z.infer<typeof RoomTaskStateSchema>;

export const RoomTaskFileSchema = z
  .object({ path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })
  .strict()
  .meta({ id: 'RoomTaskFile' });

export const RoomTaskQuestionSchema = z
  .object({
    id: z.string().min(1).max(200),
    method: PiDialogMethodSchema,
    title: z.string().max(2000),
    message: z.string().max(8000).optional(),
    options: z.array(z.string().max(500)).max(50).optional(),
    placeholder: z.string().max(500).optional(),
    tool: z.string().max(200).optional(),
  })
  .strict()
  .meta({ id: 'RoomTaskQuestion' });
export type RoomTaskQuestion = z.infer<typeof RoomTaskQuestionSchema>;

export const RoomTaskAnswerSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            confirmed: z.boolean().optional(),
            value: z.string().max(32000).optional(),
            cancelled: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .meta({ id: 'RoomTaskAnswer' });
export type RoomTaskAnswer = z.infer<typeof RoomTaskAnswerSchema>;

export const RoomTaskSchema = z
  .object({
    id: z.uuid(),
    roomId: RoomIdSchema,
    title: z.string().min(1).max(200),
    brief: z.string().max(8000),
    acceptance: z.string().max(4000),
    state: RoomTaskStateSchema,
    environmentId: InstanceIdSchema,
    attempt: z.number().int().positive(),
    base: z.string(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    report: z.string().max(32000).nullable(),
    files: z.array(RoomTaskFileSchema),
    questions: z.array(RoomTaskQuestionSchema),
    review: z.enum(['none', 'pending', 'accepted']),
    reviewRounds: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'RoomTask' });
export type RoomTask = z.infer<typeof RoomTaskSchema>;

export const RoomDetailSchema = z
  .object({
    room: RoomSchema,
    summary: z.string().max(4000),
    lead: RoomLeadStateSchema,
    leadThreadId: z.string().nullable(),
    projectFolder: z.string().nullable(),
    mode: z.enum(['supervised', 'assisted']),
    paused: z.boolean(),
    leadQuestions: z.array(RoomTaskQuestionSchema),
    events: z.array(RoomEventSchema),
    tasks: z.array(RoomTaskSchema),
  })
  .strict()
  .meta({ id: 'RoomDetail' });
export type RoomDetail = z.infer<typeof RoomDetailSchema>;

export const RoomImageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    data: z.string().min(1).max(10_000_000),
  })
  .strict()
  .meta({ id: 'RoomImage' });
export type RoomImage = z.infer<typeof RoomImageSchema>;

export const PostRoomMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(8000),
    route: z.enum(['lead', 'none']),
    images: z.array(RoomImageSchema).max(6).optional(),
  })
  .strict()
  .refine((message) => message.route === 'lead' || !message.images?.length, {
    message: 'Images go to the lead; a post without prompting carries text only.',
    path: ['images'],
  })
  .meta({ id: 'PostRoomMessage' });
export type PostRoomMessage = z.infer<typeof PostRoomMessageSchema>;

export const RoomStreamLineSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('event'), event: RoomEventSchema }).strict(),
    z
      .object({
        type: z.literal('lead'),
        state: RoomLeadStateSchema,
        questions: z.array(RoomTaskQuestionSchema).optional(),
      })
      .strict(),
    z.object({ type: z.literal('room'), mode: RoomModeSchema, paused: z.boolean() }).strict(),
    z.object({ type: z.literal('task'), task: RoomTaskSchema }).strict(),
  ])
  .meta({ id: 'RoomStreamLine' });
export type RoomStreamLine = z.infer<typeof RoomStreamLineSchema>;

export const RoomEventsQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().optional() }).strict();

export const UpdateRoomSchema = z
  .object({ mode: RoomModeSchema.optional(), paused: z.boolean().optional() })
  .strict()
  .refine((value) => value.mode !== undefined || value.paused !== undefined, {
    message: 'Change the mode, the pause, or both.',
  })
  .meta({ id: 'UpdateRoom' });
export type UpdateRoom = z.infer<typeof UpdateRoomSchema>;

export const ApproveRoomTaskSchema = z
  .object({ environmentId: InstanceIdSchema.optional() })
  .strict()
  .meta({ id: 'ApproveRoomTask' });
export type ApproveRoomTask = z.infer<typeof ApproveRoomTaskSchema>;

export const RoomWorkerCandidateSchema = z
  .object({
    environmentId: InstanceIdSchema,
    name: z.string(),
    local: z.boolean(),
    ready: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'RoomWorkerCandidate' });
export type RoomWorkerCandidate = z.infer<typeof RoomWorkerCandidateSchema>;
export const RoomWorkerCandidateListSchema = z.array(RoomWorkerCandidateSchema).meta({ id: 'RoomWorkerCandidateList' });

export const RoomTaskReportSchema = z
  .object({
    attempt: z.number().int().positive(),
    environmentId: InstanceIdSchema,
    state: z.enum(['running', 'submitted', 'failed', 'stopped']),
    branch: z.string().max(300).nullable(),
    head: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
    report: z.string().max(32000).nullable(),
    files: z.array(RoomTaskFileSchema).max(2000),
    bundle: z.string().max(70_000_000).nullable(),
    note: z.string().max(2000).nullable(),
    questions: z.array(RoomTaskQuestionSchema).max(20).default([]),
  })
  .strict()
  .meta({ id: 'RoomTaskReport' });
export type RoomTaskReport = z.infer<typeof RoomTaskReportSchema>;

export const RoomDirectoryEntrySchema = z
  .object({
    room: RoomSchema,
    hostName: z.string(),
    local: z.boolean(),
    hostReachable: z.boolean(),
    lastSeenAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'RoomDirectoryEntry' });
export type RoomDirectoryEntry = z.infer<typeof RoomDirectoryEntrySchema>;
export const RoomDirectorySchema = z.array(RoomDirectoryEntrySchema).meta({ id: 'RoomDirectory' });
