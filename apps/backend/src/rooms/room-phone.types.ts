import { z } from 'zod';

export const PhoneAttachmentSchema = z
  .object({
    name: z.string().max(500),
    mime: z.string().max(200),
    size: z.number().finite().nonnegative(),
    type: z.string().min(1).max(40),
    path: z.string().optional(),
  })
  .strict();
export const PhoneAttachmentsSchema = z.array(PhoneAttachmentSchema).max(10);
export type PhoneAttachment = z.infer<typeof PhoneAttachmentSchema>;
export const PhonePromptKindSchema = z.enum(['question', 'action', 'test']);
export type PhonePromptKind = z.infer<typeof PhonePromptKindSchema>;
export const PhoneDeliveryKindSchema = z.enum(['reply', 'proactive', 'status', 'question', 'action', 'test']);
export type PhoneDeliveryKind = z.infer<typeof PhoneDeliveryKindSchema>;
export interface PhonePromptDraft {
  token: string;
  text: string;
  expiresAt: number;
  consumed: boolean;
}

export interface PhoneMessage {
  id: string;
  group: string;
  sender: string;
  senderName: string;
  groupName: string;
  text: string;
  quoteId?: string;
  raw?: string;
  files?: PhoneAttachment[];
}
