import { z } from 'zod';

/**
 * Updates from inside the app: which pi the backend runs and where it came from, what is outdated, and the
 * background job that brings pi, its packages, the model catalogs and pi-kit itself up to date.
 */

/** Where the pi SDK the backend loaded came from, in order of precedence. */
export const PI_SOURCES = ['env', 'managed', 'bundled'] as const;
export const PiSourceSchema = z.enum(PI_SOURCES);
export type PiSource = z.infer<typeof PiSourceSchema>;

/** The SDK range pi-kit was built against (`piSdk` in the root `package.json`): `min` inclusive, `max` inclusive, both `x.y.z`. */
export const PiSdkRangeSchema = z.object({ min: z.string(), max: z.string() });
export type PiSdkRange = z.infer<typeof PiSdkRangeSchema>;

export const ManagedReleaseSchema = z.object({
  version: z.string(),
  dir: z.string(),
  /** `package.json` and `node_modules` are there and the release names its own version. */
  intact: z.boolean(),
  /** Inside `piSdk`. */
  inRange: z.boolean(),
});
export type ManagedRelease = z.infer<typeof ManagedReleaseSchema>;

/** The result of choosing a pi (`resolvePi`): what runs, what was passed over and why. */
export const PiResolutionSchema = z.object({
  source: PiSourceSchema,
  version: z.string(),
  /** The folder of the `@earendil-works/pi-coding-agent` package that was loaded. */
  packageDir: z.string(),
  bundled: z.object({ version: z.string(), packageDir: z.string() }),
  range: PiSdkRangeSchema,
  /** pi's managed install (`<agent dir>/install`), when there is one. */
  managed: z
    .object({
      root: z.string(),
      /** What `current-version` names (the release the `pi` command runs). */
      current: z.string().optional(),
      releases: z.array(ManagedReleaseSchema),
    })
    .optional(),
  /** "Use previous release": a version (or `bundled`) the user chose over the newest. */
  pinned: z.string().optional(),
  /** Why something that exists was not used; shown as a line in Settings. */
  notes: z.array(z.string()),
}).meta({ id: 'PiResolution' });
export type PiResolution = z.infer<typeof PiResolutionSchema>;

export const UPDATE_TARGETS = ['pi', 'packages', 'models', 'app'] as const;
export const UpdateTargetSchema = z.enum(UPDATE_TARGETS);
export type UpdateTarget = z.infer<typeof UpdateTargetSchema>;

export const UpdateRequestSchema = z.object({ targets: z.array(UpdateTargetSchema).min(1) }).strict().meta({ id: 'UpdateRequest' });
export type UpdateRequest = z.infer<typeof UpdateRequestSchema>;

export const UPDATE_ROW_STATES = ['unknown', 'current', 'outdated', 'running', 'done', 'failed', 'cancelled', 'unavailable'] as const;
export const UpdateRowStateSchema = z.enum(UPDATE_ROW_STATES);
export type UpdateRowState = z.infer<typeof UpdateRowStateSchema>;

export const UpdateRowSchema = z.object({
  target: UpdateTargetSchema,
  state: UpdateRowStateSchema,
  /** What is installed (pi, pi-kit). */
  current: z.string().optional(),
  /** The newest release (pi, pi-kit). */
  latest: z.string().optional(),
  /** `packages`: how many installed packages have a newer version; `models`: unused. */
  outdated: z.number().int().optional(),
  /** One muted line: what is outdated, or the last progress line of a running update. */
  detail: z.string().optional(),
  /** `packages`: the names. */
  items: z.array(z.string()).optional(),
  /** Epoch ms of the last finished update of this row (models: the last catalog refresh). */
  updatedAt: z.number().optional(),
  error: z.string().optional(),
}).meta({ id: 'UpdateRow' });
export type UpdateRow = z.infer<typeof UpdateRowSchema>;

export const UPDATE_JOB_STATES = ['running', 'done', 'failed', 'cancelled'] as const;
export const UpdateJobSchema = z.object({
  id: z.string(),
  targets: z.array(UpdateTargetSchema),
  state: z.enum(UPDATE_JOB_STATES),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  /** Where the job's output is written. */
  logPath: z.string().optional(),
}).meta({ id: 'UpdateJob' });
export type UpdateJob = z.infer<typeof UpdateJobSchema>;

/** What a restart is needed for after an update. */
export const UpdateRestartSchema = z.object({
  /** `pi`: the backend restarts to load the newer pi; `app`: pi-kit restarts to install its own update. */
  kind: z.enum(['pi', 'app']),
  /** The version that will run after the restart. */
  version: z.string(),
});
export type UpdateRestart = z.infer<typeof UpdateRestartSchema>;

export const UpdateStatusSchema = z.object({
  rows: z.array(UpdateRowSchema),
  job: UpdateJobSchema.optional(),
  /** A check is running. */
  checking: z.boolean(),
  checkedAt: z.number().optional(),
  /** The checks do not run: `PI_OFFLINE` / `PI_SKIP_VERSION_CHECK` are set (as for pi's own). */
  skipped: z.enum(['offline', 'disabled']).optional(),
  /** Anything is outdated: the dot in the sidebar footer. */
  outdated: z.boolean(),
  restart: z.array(UpdateRestartSchema),
  /** What is loaded now; the next start may choose differently (`restart`, `pinned`). */
  resolution: PiResolutionSchema,
  /** "Use previous release" is set: a managed version or `bundled`. */
  pinned: z.string().optional(),
  /** The `pi` command on PATH is a launcher of the managed install (so the terminal and the app run the same pi). */
  command: z.object({ onPath: z.boolean(), launcher: z.string().optional() }),
  desktop: z.boolean(),
}).meta({ id: 'UpdateStatus' });
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/** What `GET /api/update/events` streams (one JSON object per line). */
export const UpdateEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: UpdateStatusSchema }),
  z.object({ type: z.literal('line'), target: UpdateTargetSchema.optional(), text: z.string(), at: z.number() }),
]).meta({ id: 'UpdateEvent' });
export type UpdateEvent = z.infer<typeof UpdateEventSchema>;

/** "Use previous release" in Settings › Advanced: pin the resolution to a managed release (or `bundled`), or `null` to follow the newest. */
export const PinReleaseSchema = z.object({ release: z.string().min(1).nullable() }).strict().meta({ id: 'PinRelease' });
export type PinRelease = z.infer<typeof PinReleaseSchema>;

/** `POST /api/update/restart`. */
export const RestartingSchema = z.object({ restarting: z.literal(true) }).meta({ id: 'Restarting' });
export type Restarting = z.infer<typeof RestartingSchema>;

/** `POST /api/update/install-app`. */
export const InstallingSchema = z.object({ installing: z.literal(true) }).meta({ id: 'Installing' });
export type Installing = z.infer<typeof InstallingSchema>;

/** `GET /api/update/releases`: the managed releases "Use previous release" offers, and the one that is pinned. */
export const ReleasesSchema = z
  .object({ choices: z.array(z.object({ release: z.string(), label: z.string() })), pinned: z.string().optional() })
  .meta({ id: 'Releases' });
export type Releases = z.infer<typeof ReleasesSchema>;
