import { z } from 'zod';

export const RoomPhoneStatusSchema = z
  .object({
    connection: z.enum(['disconnected', 'connecting', 'qr', 'connected', 'error']),
    qr: z.string().nullable(),
    error: z.string().nullable(),
    binding: z
      .object({ group: z.string(), groupName: z.string(), sender: z.string(), senderName: z.string() })
      .strict()
      .nullable(),
    candidate: z
      .object({ group: z.string(), groupName: z.string(), sender: z.string(), senderName: z.string() })
      .strict()
      .nullable(),
    expiresAt: z.number().nullable(),
    input: z
      .object({
        lastGroupAt: z.number().nullable(),
        lastOwnGroupAt: z.number().nullable(),
        lastAcceptedAt: z.number().nullable(),
        ignoredHistory: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    appUrl: z.string().nullable().optional(),
    verifiedAt: z.number().nullable().optional(),
    pendingDeliveries: z.number().optional(),
    lastDelivery: z
      .object({ sentAt: z.number().nullable(), deliveredAt: z.number().nullable(), readAt: z.number().nullable() })
      .nullable()
      .optional(),
    queued: z.number(),
    needsReview: z.number(),
    review: z.array(
      z.object({ id: z.number().int(), direction: z.enum(['input', 'delivery']), text: z.string() }).strict(),
    ),
  })
  .strict()
  .meta({ id: 'RoomPhoneStatus' });
export type RoomPhoneStatus = z.infer<typeof RoomPhoneStatusSchema>;

export const RoomPhoneLinkSchema = z
  .object({ code: z.string(), expiresAt: z.number() })
  .strict()
  .meta({ id: 'RoomPhoneLink' });
export type RoomPhoneLink = z.infer<typeof RoomPhoneLinkSchema>;

export const ConfirmRoomPhoneSchema = z
  .object({
    group: z.string().min(1).max(300),
    sender: z.string().min(1).max(300),
  })
  .strict()
  .meta({ id: 'ConfirmRoomPhone' });
export type ConfirmRoomPhone = z.infer<typeof ConfirmRoomPhoneSchema>;

export const ReviewRoomPhoneSchema = z
  .object({ id: z.number().int().positive(), direction: z.enum(['input', 'delivery']) })
  .strict()
  .meta({ id: 'ReviewRoomPhone' });
export type ReviewRoomPhone = z.infer<typeof ReviewRoomPhoneSchema>;
export const RoomPhoneConfigSchema = z
  .object({
    appUrl: z
      .string()
      .max(2000)
      .refine((value) => {
        try {
          const url = value ? new URL(value) : undefined;
          return !url || (url.protocol === 'https:' && !url.username && !url.password);
        } catch {
          return false;
        }
      }, 'Use the HTTPS address of the paired phone application.'),
  })
  .strict()
  .meta({ id: 'RoomPhoneConfig' });
export type RoomPhoneConfig = z.infer<typeof RoomPhoneConfigSchema>;
