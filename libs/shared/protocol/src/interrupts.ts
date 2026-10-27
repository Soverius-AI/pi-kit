import { z } from 'zod';

/**
 * Extension dialogs as AG-UI interrupts. pi's `ExtensionUIContext`
 * dialogs (`confirm`, `select`, `input`, `editor`) become an `Interrupt` with `reason` `pi.ui.<method>`
 * and this metadata; the answer comes back as a `ResumeEntry` whose payload is `PiDialogAnswer`.
 */

export const PI_DIALOG_METHODS = ['confirm', 'select', 'input', 'editor'] as const;
export const PiDialogMethodSchema = z.enum(PI_DIALOG_METHODS);
export type PiDialogMethod = z.infer<typeof PiDialogMethodSchema>;

export const PiDialogRequestSchema = z.object({
  method: PiDialogMethodSchema,
  title: z.string(),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
  /** Which extension asked: its name, read from the call site (pi's UI context does not say who is calling). */
  source: z.string().optional(),
  /** Which background agent asked: its name. The dialog then belongs to the agent, not to pi. */
  agent: z.string().optional(),
  /** The tool call that was running when the dialog opened, e.g. a `tool_call` hook guarding `bash`. */
  tool: z.string().optional(),
  /** Standard AG-UI correlation with the tool call waiting for the answer. */
  toolCallId: z.string().optional(),
  /** pi's `timeout` option of the dialog, in milliseconds. The host does not enforce it (see `UiBridge`); the block shows it and answers "cancelled" when it passes. */
  timeoutMs: z.number().int().positive().optional(),
  /** Epoch milliseconds when `timeoutMs` runs out, counted from the moment the extension asked (so a reload keeps the countdown). */
  expiresAt: z.number().optional(),
});
export type PiDialogRequest = z.infer<typeof PiDialogRequestSchema>;

export const PiDialogAnswerSchema = z.union([z.object({ confirmed: z.boolean() }), z.object({ value: z.string() })]);
export type PiDialogAnswer = z.infer<typeof PiDialogAnswerSchema>;

export const piInterruptReason = (method: PiDialogMethod): string => `pi.ui.${method}`;
export const isPiInterruptReason = (reason: string): boolean => reason.startsWith('pi.ui.');
