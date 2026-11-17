import { z } from 'zod';

/** Owner opt-in to automatic backend recovery, independent of background-service lifetime. */
export const WatchdogSettingsSchema = z.object({ enabled: z.boolean(), supported: z.boolean() });
export type WatchdogSettings = z.infer<typeof WatchdogSettingsSchema>;
export const SetWatchdogSchema = z.object({ enabled: z.boolean() });
