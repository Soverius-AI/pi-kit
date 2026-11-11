import { z } from 'zod';

export const ThreadProtectionModeSchema = z.enum(['bypass', 'sandboxed']);
export type ThreadProtectionMode = z.infer<typeof ThreadProtectionModeSchema>;

export const ThreadProtectionStateSchema = z.enum([
  'bypass',
  'idle',
  'starting',
  'active',
  'experimental',
  'unavailable',
  'setup-required',
  'recovery-required',
]);
export type ThreadProtectionState = z.infer<typeof ThreadProtectionStateSchema>;

export const ThreadProtectionSchema = z
  .object({
    mode: ThreadProtectionModeSchema,
    state: ThreadProtectionStateSchema,
    generation: z.number().int().nonnegative(),
    experimentalWindowsAccepted: z.boolean(),
    platform: z.string().meta({ description: 'Platform of the backend, not of the browser.' }),
    reason: z.string().nullable().meta({ description: 'Technical detail of an unavailable or held sandbox.' }),
  })
  .strict()
  .meta({ id: 'ThreadProtection' });
export type ThreadProtection = z.infer<typeof ThreadProtectionSchema>;

export const SetThreadProtectionSchema = z
  .object({
    mode: ThreadProtectionModeSchema,
    experimentalWindowsAccepted: z.boolean().optional(),
    confirmBypass: z.boolean().optional().meta({ description: 'Required to downgrade a protected thread.' }),
    confirmRecovery: z.boolean().optional().meta({
      description: 'Required while recovery is needed: the person checked that earlier sandbox work stopped.',
    }),
  })
  .strict()
  .meta({ id: 'SetThreadProtection' });
export type SetThreadProtection = z.infer<typeof SetThreadProtectionSchema>;
