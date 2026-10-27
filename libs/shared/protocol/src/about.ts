import { z } from 'zod';
import { QueryFlagSchema } from './query';

/** What Settings › General shows about the app and the pi it runs. */

export const AboutSchema = z.object({
  app: z.object({
    name: z.string(),
    version: z.string(),
    /** True in the desktop app (Electron started the backend), false for `npm run dev:web`. */
    desktop: z.boolean(),
  }),
  pi: z.object({
    /** The pi SDK this app runs sessions with (the newest compatible copy). */
    version: z.string(),
    packageName: z.string(),
    packageDir: z.string(),
    /** Where that copy came: `PI_KIT_PI_DIR`, pi's managed install, or the copy bundled with pi-kit. */
    source: z.enum(['env', 'managed', 'bundled']).default('bundled'),
    /** The SDK range this pi-kit supports (`piSdk`). */
    range: z.object({ min: z.string(), max: z.string() }).optional(),
    /** Lines such as "pi 2.0 is installed, pi-kit supports up to 1.x; using the bundled 1.3.0". */
    notes: z.array(z.string()).default([]),
  }),
  node: z.string(),
}).meta({ id: 'About' });
export type About = z.infer<typeof AboutSchema>;

/** Result of asking pi's release endpoint whether a newer pi exists. It never installs anything. */
export const PiUpdateCheckSchema = z.object({
  current: z.string(),
  /** The newest published version; absent when the check was skipped or failed. */
  latest: z.string().optional(),
  updateAvailable: z.boolean(),
  /** A note the release endpoint attaches to the version. */
  note: z.string().optional(),
  checkedAt: z.number(),
  /** The check did not run: pi's own switches `PI_OFFLINE` / `PI_SKIP_VERSION_CHECK` are set. */
  skipped: z.enum(['offline', 'disabled']).optional(),
  error: z.string().optional(),
  /** What the user runs themselves to update the `pi` command line tool. */
  command: z.string(),
}).meta({ id: 'PiUpdateCheck' });
export type PiUpdateCheck = z.infer<typeof PiUpdateCheckSchema>;

/** `GET /api/health`. `bootId` differs for every backend process; a client that sees it change knows the backend restarted. */
export const HealthSchema = z
  .object({
    status: z.literal('ok'),
    bootId: z.string(),
    startedAt: z.number(),
    pid: z.number().int(),
    /** Whether this backend runs the background agents, and why not: no credential store, or another backend owns the store. */
    backgroundAgents: z.object({ enabled: z.boolean(), reason: z.string().optional() }),
  })
  .meta({ id: 'Health' });
export type Health = z.infer<typeof HealthSchema>;

/** `GET /api/about/pi-update?force=1`: skip the ten minute cache. */
export const PiUpdateQuerySchema = z.object({ force: QueryFlagSchema.optional() });
