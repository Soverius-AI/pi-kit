import { z } from 'zod';

/** The two macOS permissions computer use needs (`@pi-kit/computer-use`). */
export const ComputerUsePermissionSchema = z.enum(['accessibility', 'screenRecording']).meta({ id: 'ComputerUsePermission' });
export type ComputerUsePermission = z.infer<typeof ComputerUsePermissionSchema>;

/** Settings › Computer use: whether it is on, which app macOS asks, (macOS, while it is on) what macOS has granted, and (Linux) whether this is Hyprland. */
export const ComputerUseStateSchema = z
  .object({
    /** pi has the `@pi-kit/computer-use` package (pi-kit installs it once; `pi remove` takes it away). */
    installed: z.boolean(),
    /** macOS, Windows or Linux. */
    supported: z.boolean(),
    platform: z.string(),
    /** The saved choice (`<agent dir>/computer-use.json`), the same one `/computer-use on | off` writes. */
    enabled: z.boolean(),
    /** The app macOS gives the permissions to: pi-kit, Electron for a development build, or the terminal that started the backend. */
    host: z.object({
      name: z.string(),
      kind: z.enum(['app', 'development', 'terminal']),
      /** An ad-hoc signed build: macOS forgets its permissions whenever it is rebuilt. */
      adHoc: z.boolean().optional(),
    }),
    /** What macOS has granted this process; `null` outside macOS, while computer use is off (its native library is not loaded) or without the package. */
    permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }).nullable(),
    /** Screen Recording was asked for since this app started: macOS applies it only after a relaunch. */
    needsRelaunch: z.boolean(),
    /** Linux: a Hyprland session, where computer use is read-only (Cua Driver cannot click or type there yet). */
    hyprland: z.boolean().optional(),
  })
  .meta({ id: 'ComputerUseState' });
export type ComputerUseState = z.infer<typeof ComputerUseStateSchema>;

export const SetComputerUseSchema = z.object({ enabled: z.boolean() }).meta({ id: 'SetComputerUse' });
export type SetComputerUse = z.infer<typeof SetComputerUseSchema>;
