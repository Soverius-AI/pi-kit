import { z } from 'zod';
import { PlaybookAgentSettingsSchema } from './playbooks';
import { InstanceIdSchema } from './environments';
import { RoomIdSchema, RoomTaskFileSchema, RoomTaskQuestionSchema } from './rooms';

export const A2A_VERSION = '1.0';
export const A2A_VERSION_HEADER = 'a2a-version';
export const A2A_TOKEN_HEADER = 'x-a2a-notification-token';
export const A2A_EXTENSIONS_HEADER = 'a2a-extensions';
export const A2A_ROOM_EXTENSION = 'https://pi-kit.dev/a2a/extensions/room-task/v1';
export const A2A_PEER_SCHEME = 'pi-kit-peer:';
export const A2A_BUNDLE_MEDIA_TYPE = 'application/x-git-bundle';

export const A2aJsonSchema = z.record(z.string(), z.unknown()).meta({ id: 'A2aJson' });

export const A2aServiceParametersSchema = z
  .object({ 'A2A-Version': z.string().max(20).optional(), 'A2A-Extensions': z.string().max(2000).optional() })
  .strict();

export const A2aRoomTaskOfferSchema = z
  .object({
    roomId: RoomIdSchema,
    roomTitle: z.string().max(200),
    taskId: z.uuid(),
    attempt: z.number().int().positive(),
    title: z.string().min(1).max(200),
    brief: z.string().max(8000),
    acceptance: z.string().max(4000),
    repository: z.string().min(1).max(512),
    base: z.string().regex(/^[0-9a-f]{40,64}$/),
    from: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    feedback: z.string().max(8000).optional(),
    round: z.number().int().positive().optional(),
  })
  .strict()
  .meta({ id: 'A2aRoomTaskOffer' });
export type A2aRoomTaskOffer = z.infer<typeof A2aRoomTaskOfferSchema>;

export const A2aRoomTaskProgressSchema = z
  .object({
    taskId: z.uuid(),
    attempt: z.number().int().positive(),
    environmentId: InstanceIdSchema,
    branch: z.string().max(300).nullable().optional(),
    head: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable()
      .optional(),
    files: z.array(RoomTaskFileSchema).max(2000).optional(),
    questions: z.array(RoomTaskQuestionSchema).max(20).optional(),
  })
  .strict()
  .meta({ id: 'A2aRoomTaskProgress' });
export type A2aRoomTaskProgress = z.infer<typeof A2aRoomTaskProgressSchema>;

export const A2aAgentSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(200),
    url: z.string().min(1).max(2000),
    tokenStorage: z.enum(['none', 'keychain', 'database']),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: 'A2aAgent' });
export type A2aAgent = z.infer<typeof A2aAgentSchema>;

export const A2aAgentListSchema = z.array(A2aAgentSchema).meta({ id: 'A2aAgentList' });

export const AddA2aAgentSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .regex(/^https?:\/\//, 'Give the http(s) address of the agent or of its agent card.'),
    token: z.string().trim().max(4000).optional(),
  })
  .strict()
  .meta({ id: 'AddA2aAgent' });
export type AddA2aAgent = z.infer<typeof AddA2aAgentSchema>;

export const A2aRoomConsultSchema = z
  .object({
    consult: z.literal(true),
    roomId: RoomIdSchema,
    roomTitle: z.string().max(200),
    repository: z.string().max(512),
    base: z.union([z.literal(''), z.string().regex(/^[0-9a-f]{40,64}$/)]),
    role: z.string().min(1).max(40),
    instructions: z.string().max(4000),
    question: z.string().min(1).max(32000),
    settings: PlaybookAgentSettingsSchema.optional(),
  })
  .strict()
  .meta({ id: 'A2aRoomConsult' });
export type A2aRoomConsult = z.infer<typeof A2aRoomConsultSchema>;
