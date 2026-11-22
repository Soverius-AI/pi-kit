import { z } from 'zod';

/** Labels are never routing keys. Reject invisible direction/control characters in consent UI. */
export const EnvironmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, 'Use a plain-text environment name.');
export const InstanceIdSchema = z.uuid();

export const ENVIRONMENT_ICONS = [
  'runner',
  'neko',
  'drone',
  'mech',
  'katana',
  'skull',
  'glitch',
  'spinner',
  'oni',
] as const;
/** Recognition only, never a routing key: one of nine icons in one of nine identity colours (`--pk-identity-1..9`). */
export const EnvironmentLookSchema = z
  .object({ icon: z.enum(ENVIRONMENT_ICONS), color: z.number().int().min(1).max(9) })
  .strict()
  .meta({ id: 'EnvironmentLook' });
export type EnvironmentLook = z.infer<typeof EnvironmentLookSchema>;

/** Hashed from the instance id, so a fresh install and an older peer that reports no look still have one. */
export function defaultEnvironmentLook(instanceId: string): EnvironmentLook {
  let hash = 2166136261;
  for (const char of instanceId.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return { icon: ENVIRONMENT_ICONS[hash % 9], color: (Math.floor(hash / 9) % 9) + 1 };
}

export const EnvironmentSchema = z
  .object({
    instanceId: InstanceIdSchema,
    name: EnvironmentNameSchema,
    protocolVersion: z.literal(1),
    look: EnvironmentLookSchema.optional(),
  })
  .meta({ id: 'Environment' });
export type Environment = z.infer<typeof EnvironmentSchema>;
export const RenameEnvironmentSchema = z
  .object({ name: EnvironmentNameSchema })
  .strict()
  .meta({ id: 'RenameEnvironment' });

/** cwd is the owner's stored project root, never normalized using the controller OS. */
export const ProjectRefSchema = z
  .object({ instanceId: InstanceIdSchema, cwd: z.string().min(1) })
  .strict()
  .meta({ id: 'ProjectRef' });
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
export const ThreadRefSchema = z
  .object({ instanceId: InstanceIdSchema, threadId: z.string().min(1) })
  .strict()
  .meta({ id: 'ThreadRef' });
export type ThreadRef = z.infer<typeof ThreadRefSchema>;

/** Structured tuple keys avoid ambiguous path/ID delimiters and cross-instance collisions. */
export function projectRefKey(ref: ProjectRef): string {
  return JSON.stringify([ref.instanceId, ref.cwd]);
}
export function threadRefKey(ref: ThreadRef): string {
  return JSON.stringify([ref.instanceId, ref.threadId]);
}
export function sameProject(a: ProjectRef, b: ProjectRef): boolean {
  return a.instanceId === b.instanceId && a.cwd === b.cwd;
}

export const InstanceAccessPreferencesSchema = z
  .object({
    desiredEnabled: z.boolean(),
    httpsPort: z.number().int().min(1).max(65535),
  })
  .strict()
  .meta({ id: 'InstanceAccessPreferences' });
export type InstanceAccessPreferences = z.infer<typeof InstanceAccessPreferencesSchema>;

/** PRIVATE desktop/backend contract. Never expose through the phone API allowlist. No raw cookie is stored. */
export const StoredDeviceGrantSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    name: z.string().max(100),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
    cookieHash: z.string().regex(/^[a-f0-9]{64}$/),
    csrf: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  })
  .strict()
  .meta({ id: 'StoredDeviceGrant' });
export type StoredDeviceGrant = z.infer<typeof StoredDeviceGrantSchema>;
export const StoredDeviceGrantsSchema = z.array(StoredDeviceGrantSchema).max(20).meta({ id: 'StoredDeviceGrants' });
