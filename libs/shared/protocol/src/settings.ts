import { z } from 'zod';

/** REST shapes of the settings overhaul: diagnostics, saved trust decisions, the resource inventory, keybinding edits, key validation. */

// ---- diagnostics (Settings › Advanced)

export const DiagnosticsSchema = z.object({
  backend: z.object({
    host: z.string(),
    port: z.number().int(),
    /** Differs for every backend process; a client that sees it change knows the backend restarted. */
    bootId: z.string(),
    startedAt: z.number(),
    pid: z.number().int(),
    desktop: z.boolean(),
    dev: z.boolean(),
  }),
  app: z.object({ version: z.string(), node: z.string(), platform: z.string(), arch: z.string() }),
  pi: z.object({ version: z.string(), source: z.enum(['env', 'managed', 'bundled']), packageDir: z.string(), agentDir: z.string() }),
  paths: z.object({ dataDir: z.string(), database: z.string(), logDir: z.string(), defaultCwd: z.string() }),
  logs: z.array(z.object({ name: z.string(), path: z.string(), size: z.number(), modified: z.number() })),
  /** The switches that change what the backend does, as set (values of flags only, never anything secret). */
  flags: z.array(z.object({ name: z.string(), value: z.string() })),
}).meta({ id: 'Diagnostics' });
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

// ---- saved trust decisions (pi's trust.json)

export const TrustEntrySchema = z.object({
  path: z.string(),
  decision: z.boolean(),
  /** The folder is one pi-kit has opened as a workspace. */
  known: z.boolean(),
  exists: z.boolean(),
});
export type TrustEntry = z.infer<typeof TrustEntrySchema>;

export const TrustListSchema = z.object({ file: z.string(), entries: z.array(TrustEntrySchema) }).meta({ id: 'TrustList' });
export type TrustList = z.infer<typeof TrustListSchema>;

export const RevokeTrustSchema = z.object({ path: z.string().min(1) }).strict().meta({ id: 'RevokeTrust' });

// ---- extensions, skills, prompt templates

export const RESOURCE_TYPES = ['extensions', 'skills', 'prompts'] as const;
export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const ResourceItemSchema = z.object({
  /** Stable key for the row: `<type>:<scope>:<source>:<path>`. */
  key: z.string(),
  type: ResourceTypeSchema,
  name: z.string(),
  /** A skill’s or prompt template’s own description. */
  description: z.string().optional(),
  path: z.string(),
  enabled: z.boolean(),
  /** `user`: the agent folder’s settings; `project`: the folder’s `.pi/settings.json` (trusted folders only). */
  scope: z.enum(['user', 'project']),
  /** `package`: from an installed package; `top-level`: a file or folder in settings or auto-discovered; `builtin`: shipped with pi. */
  origin: z.enum(['package', 'top-level', 'builtin']),
  /** The package source, `local`, `auto`, or `builtin`. */
  source: z.string(),
  /** A line for the row: “User (~/.pi/agent)”, “npm:pi-subagents”, “Built-in”. */
  label: z.string(),
});
export type ResourceItem = z.infer<typeof ResourceItemSchema>;

export const ResourcesOverviewSchema = z.object({
  items: z.array(ResourceItemSchema),
  /** The folder the project scope was read for, when it is trusted. */
  projectCwd: z.string().optional(),
  /** Project resources exist but the folder is not trusted, so they are not listed. */
  projectSkipped: z.boolean(),
  errors: z.array(z.string()),
}).meta({ id: 'ResourcesOverview' });
export type ResourcesOverview = z.infer<typeof ResourcesOverviewSchema>;

export const ToggleResourceSchema = z
  .object({
    key: z.string().min(1),
    enabled: z.boolean(),
    cwd: z.string().min(1).optional(),
  })
  .strict().meta({ id: 'ToggleResource' });

// ---- keybindings

/** The customised keys of pi’s actions: `{ "app.session.new": ["ctrl+shift+n"] }`. An action not listed has pi’s default. */
export const PiKeybindingOverridesSchema = z.record(z.string().regex(/^[\w.]+$/), z.array(z.string().min(1).max(64)).max(8));
export const SavePiKeybindingsSchema = z.object({ overrides: PiKeybindingOverridesSchema }).strict().meta({ id: 'SavePiKeybindings' });
export type SavePiKeybindings = z.infer<typeof SavePiKeybindingsSchema>;

// ---- API key validation (the workflow's last step)

export const ValidateKeySchema = z.object({ provider: z.string().min(1) }).strict().meta({ id: 'ValidateKey' });
export const KeyValidationSchema = z.object({
  /** `ok`: one request worked; `rejected`: the provider refused the credential; `unchecked`: it could not be asked (offline, no model to ask). */
  status: z.enum(['ok', 'rejected', 'unchecked']),
  message: z.string(),
  models: z.number().int(),
  /** A few model ids the credential gives access to. */
  sample: z.array(z.string()),
}).meta({ id: 'KeyValidation' });
export type KeyValidation = z.infer<typeof KeyValidationSchema>;

// ---- what the sign-in and trust routes answer with

/** `POST /api/auth/login`: the id of the sign-in that was started; its events are on `GET /api/auth/login/:id/events`. */
export const LoginStartedSchema = z.object({ id: z.string() }).meta({ id: 'LoginStarted' });
export type LoginStarted = z.infer<typeof LoginStartedSchema>;

/** `POST /api/trust/revoke`: the list afterwards, and what happened to the pi sessions that were open (idle ones were closed and reopen under the new answer; running ones were left alone). */
export const RevokeTrustResultSchema = TrustListSchema.extend({ reopened: z.number().int(), running: z.number().int() }).meta({ id: 'RevokeTrustResult' });
export type RevokeTrustResult = z.infer<typeof RevokeTrustResultSchema>;
