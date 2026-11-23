import { z } from 'zod';
import { RoomFactSchema } from './playbooks';

export const RoomTimezoneSchema = z
  .string()
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid IANA timezone.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const RoomAssistantPolicySchema = z
  .object({
    enabled: z.boolean(),
    timezone: RoomTimezoneSchema,
    quietStart: time.nullable(),
    quietEnd: time.nullable(),
    dailyLimit: z.number().int().min(1).max(100),
    dailyRunLimit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .meta({ id: 'RoomAssistantPolicy' });
export type RoomAssistantPolicy = z.infer<typeof RoomAssistantPolicySchema>;

export const RoomCommitmentInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    details: z.string().max(8000).default(''),
    dueAt: z.number().int().nonnegative(),
    timezone: RoomTimezoneSchema,
    dailyAt: time.nullable().default(null),
    source: z.string().max(500).default('owner'),
  })
  .strict()
  .meta({ id: 'RoomCommitmentInput' });
export type RoomCommitmentInput = z.infer<typeof RoomCommitmentInputSchema>;
export const RoomCommitmentSchema = RoomCommitmentInputSchema.extend({
  id: z.uuid(),
  state: z.enum(['open', 'done', 'cancelled']),
  lastFiredAt: z.number().nullable(),
}).meta({ id: 'RoomCommitment' });
export type RoomCommitment = z.infer<typeof RoomCommitmentSchema>;
export const ChangeRoomCommitmentSchema = z
  .object({
    state: z.enum(['open', 'done', 'cancelled']).optional(),
    dueAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => value.state !== undefined || value.dueAt !== undefined)
  .meta({ id: 'ChangeRoomCommitment' });
export type ChangeRoomCommitment = z.infer<typeof ChangeRoomCommitmentSchema>;

export const RoomFolderInputSchema = z
  .object({
    alias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    target: z.string().min(1).max(4096),
  })
  .strict()
  .meta({ id: 'RoomFolderInput' });
export type RoomFolderInput = z.infer<typeof RoomFolderInputSchema>;
export const RoomFolderSchema = RoomFolderInputSchema.extend({
  id: z.uuid(),
  environmentId: z.uuid(),
  canonical: z.string(),
  access: z.literal('read'),
  available: z.boolean(),
  reason: z.string().nullable(),
}).meta({ id: 'RoomFolder' });
export type RoomFolder = z.infer<typeof RoomFolderSchema>;

export const RoomFactInputSchema = RoomFactSchema.pick({ key: true, text: true })
  .extend({ key: RoomFactSchema.shape.key.trim().min(1).max(80), text: RoomFactSchema.shape.text.max(8000) })
  .strict()
  .meta({ id: 'RoomFactInput' });
export type RoomFactInput = z.infer<typeof RoomFactInputSchema>;
export const RoomAssistantStatusSchema = z
  .object({
    policy: RoomAssistantPolicySchema,
    memory: z.array(RoomFactSchema),
    commitments: z.array(RoomCommitmentSchema),
    folders: z.array(RoomFolderSchema),
    workspace: z.string(),
    files: z.array(z.object({ path: z.string(), size: z.number() }).strict()).optional(),
    work: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          state: z.enum(['queued', 'running', 'done', 'failed', 'review']),
          kind: z.string(),
          createdAt: z.number(),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: 'RoomAssistantStatus' });
export type RoomAssistantStatus = z.infer<typeof RoomAssistantStatusSchema>;

export const RoomAssistantCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), query: z.string().trim().min(1).max(200).optional() }).strict(),
  RoomFactInputSchema.extend({ action: z.literal('remember') }).strict(),
  z.object({ action: z.literal('forget'), key: RoomFactInputSchema.shape.key }).strict(),
  z
    .object({
      action: z.literal('commitment'),
      title: RoomCommitmentInputSchema.shape.title,
      text: RoomCommitmentInputSchema.shape.details.optional(),
      dueAt: RoomCommitmentInputSchema.shape.dueAt.optional(),
      timezone: RoomTimezoneSchema.optional(),
      dailyAt: time.optional(),
    })
    .strict()
    .refine(
      (value) => value.dueAt !== undefined || value.dailyAt !== undefined,
      'A due time or daily time is required.',
    ),
  z.object({ action: z.literal('complete'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('cancel'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('snooze'), id: z.uuid(), dueAt: RoomCommitmentInputSchema.shape.dueAt }).strict(),
  z
    .object({
      action: z.literal('output'),
      path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
      text: z.string().min(1).max(8000),
    })
    .strict(),
  z.object({ action: z.literal('search'), query: z.string().trim().min(1).max(200) }).strict(),
]);
export type RoomAssistantCommand = z.infer<typeof RoomAssistantCommandSchema>;
export const RoomFileQuerySchema = z.object({ path: z.string().regex(/^(inbox|outputs)\/[a-zA-Z0-9_.-]+$/) }).strict();
export const RoomFileSchema = z
  .object({ name: z.string(), data: z.string(), mime: z.string() })
  .strict()
  .meta({ id: 'RoomFile' });
export type RoomFile = z.infer<typeof RoomFileSchema>;
