import { z } from 'zod';
import { QueryFlagSchema } from './query';

/**
 * REST shapes of the workspace panels: the file tree, the terminal, project trust, pi's settings
 * and provider login.
 */

// ---- files

export const FileNodeSchema = z.object({
  name: z.string(),
  /** Relative to the workspace folder, `/` separators, no trailing slash. */
  path: z.string(),
  dir: z.boolean(),
  /** Bytes (files only) and last modification in ms since the epoch; the Files panel shows them at 1440 and wider. */
  size: z.number().int().nonnegative().optional(),
  mtime: z.number().optional(),
  /** Listed because "Show ignored" is on: git ignores it. */
  ignored: z.boolean().optional(),
  /** In git's index but gone from the disk (a deleted file); it stays in the tree with the D badge. */
  missing: z.boolean().optional(),
}).meta({ id: 'FileNode' });
export type FileNode = z.infer<typeof FileNodeSchema>;

// ---- terminal

export const TerminalInfoSchema = z.object({
  cwd: z.string(),
  shell: z.string(),
  pid: z.number().int(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** False when the workspace already had a running terminal that this call attached to. */
  created: z.boolean(),
}).meta({ id: 'TerminalInfo' });
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const TerminalStartSchema = z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).strict().meta({ id: 'TerminalStart' });
export const TerminalInputSchema = z.object({ data: z.string().max(64 * 1024) }).strict().meta({ id: 'TerminalInput' });
export const TerminalResizeSchema = TerminalStartSchema;

/** One line of the terminal stream (newline-delimited JSON): output, or the shell ending. */
export const TerminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable(), signal: z.number().int().nullable().optional() }),
]).meta({ id: 'TerminalEvent' });
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

// ---- project trust (docs/security.md of pi)

export const TrustResourceKindSchema = z.enum(['extension', 'skill', 'mcp', 'prompt', 'theme', 'settings', 'prompt-file']);
export type TrustResourceKind = z.infer<typeof TrustResourceKindSchema>;

export const TrustResourceSchema = z.object({
  kind: TrustResourceKindSchema,
  /** Relative to the folder (a skill in an ancestor's `.agents/skills` is shown with its own path). */
  path: z.string(),
  /** `.pi/mcp.json`: the number of servers it defines. */
  servers: z.number().int().optional(),
});
export type TrustResource = z.infer<typeof TrustResourceSchema>;

/** Where the answer for a folder came from. */
export const TrustSourceSchema = z.enum(['none', 'override', 'extension', 'saved', 'session', 'default']);
export type TrustSource = z.infer<typeof TrustSourceSchema>;

export const TrustStateSchema = z.object({
  cwd: z.string(),
  /** The folder holds project resources that pi gates behind trust. */
  hasResources: z.boolean(),
  /** `ask`: no decision yet, the dialog has to be shown. */
  status: z.enum(['trusted', 'untrusted', 'ask']),
  source: TrustSourceSchema,
  resources: z.array(TrustResourceSchema),
}).meta({ id: 'TrustState' });
export type TrustState = z.infer<typeof TrustStateSchema>;

/** `skip`: do not load project resources, ask again next time; `once`: load them until the app quits; `remember` / `never`: saved in pi's `trust.json`. */
export const TrustDecisionSchema = z.object({ decision: z.enum(['skip', 'once', 'remember', 'never']) }).strict().meta({ id: 'TrustDecision' });
export type TrustDecision = z.infer<typeof TrustDecisionSchema>['decision'];

// ---- pi settings and providers

export const DefaultProjectTrustSchema = z.enum(['ask', 'always', 'never']);
export const QueueModeSchema = z.enum(['all', 'one-at-a-time']);

export const PiSettingsSchema = z.object({
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultThinkingLevel: z.string().nullable(),
  autoCompaction: z.boolean(),
  /** `enabledModels` (pi's `enabledModels`, shown to people as "pinned models"): patterns, `null` when every model is in scope. */
  enabledModels: z.array(z.string()).nullable(),
  defaultProjectTrust: DefaultProjectTrustSchema,
  /** `retry.enabled`: agent-level retry of transient provider failures. */
  retryEnabled: z.boolean(),
  /** How queued steering and follow-up messages are delivered (`steeringMode`, `followUpMode`). */
  steeringMode: QueueModeSchema,
  followUpMode: QueueModeSchema,
  /** `enableSkillCommands`: skills are registered as `/skill:name` commands. */
  enableSkillCommands: z.boolean(),
  agentDir: z.string(),
}).meta({ id: 'PiSettings' });
export type PiSettings = z.infer<typeof PiSettingsSchema>;

export const PatchPiSettingsSchema = z
  .object({
    defaultModel: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
    defaultThinkingLevel: z.string().min(1),
    autoCompaction: z.boolean(),
    enabledModels: z.array(z.string().min(1)).nullable(),
    defaultProjectTrust: DefaultProjectTrustSchema,
    retryEnabled: z.boolean(),
    steeringMode: QueueModeSchema,
    followUpMode: QueueModeSchema,
    enableSkillCommands: z.boolean(),
  })
  .partial()
  .strict().meta({ id: 'PatchPiSettings' });
export type PatchPiSettings = z.infer<typeof PatchPiSettingsSchema>;

/**
 * What a provider says about how much of a plan or credit is used (`GET /api/providers/:id/usage`): the windows of a subscription ("5 h", "week") with the
 * share used (0 to 100) and when each resets, or the credit left on an API key. A provider with no source answers `null`.
 */
export const ProviderUsageSchema = z.object({
  windows: z.array(z.object({ name: z.string(), used: z.number().min(0).max(100), resets: z.string().optional() })),
  credit: z.string().optional(),
}).meta({ id: 'ProviderUsage' });
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const ProviderUsageQuerySchema = z.object({ refresh: QueryFlagSchema.optional() });

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Login methods the provider offers. */
  methods: z.array(z.enum(['api_key', 'oauth'])),
  /** Its OAuth sign-in is a subscription (ChatGPT, Claude, GitHub Copilot): the onboarding lists these as "a subscription you already have". */
  subscription: z.boolean().optional(),
  configured: z.boolean(),
  /** `stored` (pi's `auth.json`), `environment`, `runtime` or a config file. */
  source: z.string().optional(),
  label: z.string().optional(),
  /** A credential in `auth.json`, so "Sign out" has something to remove. */
  stored: z.boolean(),
  storedType: z.enum(['api_key', 'oauth']).optional(),
  /** What may be shown about a stored credential, never the secret itself. */
  credential: z
    .object({
      type: z.enum(['api_key', 'oauth']),
      /** Where it lives: pi's `auth.json`, the operating system's keychain (a pi-kit resolver in `auth.json`), a `!command` that prints it, or an environment variable it names. */
      store: z.enum(['auth.json', 'keychain', 'command', 'environment']),
      /** The last four characters of a literal API key; absent for OAuth tokens, commands and references. */
      lastFour: z.string().max(4).optional(),
      /** When pi-kit stored it (epoch ms); absent for a credential that was added outside pi-kit. */
      addedAt: z.number().optional(),
    })
    .optional(),
  /** Usage of the account, where the provider gives one; `null` when it was asked and has none. */
  usage: ProviderUsageSchema.nullable().optional(),
}).meta({ id: 'ProviderInfo' });
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const SettingsModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  available: z.boolean(),
  contextWindow: z.number().optional(),
  /** USD per million tokens. */
  costInput: z.number().optional(),
  costOutput: z.number().optional(),
  virtual: z.boolean().optional(),
}).meta({ id: 'SettingsModel' });
export type SettingsModel = z.infer<typeof SettingsModelSchema>;

export const KeybindingInfoSchema = z.object({
  id: z.string(),
  /** The keys in effect (pi's default, or what `keybindings.json` sets). */
  keys: z.array(z.string()),
  description: z.string(),
  /** pi's default for the action, so the editor can offer "Reset". */
  default: z.array(z.string()),
  /** `keybindings.json` overrides the default. */
  custom: z.boolean(),
}).meta({ id: 'KeybindingInfo' });
export type KeybindingInfo = z.infer<typeof KeybindingInfoSchema>;

export const SettingsOverviewSchema = z.object({
  settings: PiSettingsSchema,
  providers: z.array(ProviderInfoSchema),
  models: z.array(SettingsModelSchema),
  keybindings: z.array(KeybindingInfoSchema),
  piVersion: z.string(),
}).meta({ id: 'SettingsOverview' });
export type SettingsOverview = z.infer<typeof SettingsOverviewSchema>;

export const LoginStartSchema = z.object({ provider: z.string().min(1), type: z.enum(['api_key', 'oauth']) }).strict().meta({ id: 'LoginStart' });
/** The answer to a prompt of a sign-in. It may be an API key (a `secret` prompt), so `value` carries the secret mark. */
export const LoginAnswerSchema = z.object({ promptId: z.string().min(1), value: z.string().meta({ secret: true }) }).strict().meta({ id: 'LoginAnswer' });
export const LogoutSchema = z.object({ provider: z.string().min(1) }).strict().meta({ id: 'Logout' });

/** One line of a login stream: pi's `AuthEvent`s and `AuthPrompt`s, then `done` or `error`. */
export const LoginEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('info'), message: z.string(), links: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional() }),
  z.object({ type: z.literal('auth_url'), url: z.string(), instructions: z.string().optional() }),
  z.object({ type: z.literal('device_code'), userCode: z.string(), verificationUri: z.string() }),
  z.object({ type: z.literal('progress'), message: z.string() }),
  z.object({
    type: z.literal('prompt'),
    promptId: z.string(),
    kind: z.enum(['text', 'secret', 'select', 'manual_code']),
    message: z.string(),
    placeholder: z.string().optional(),
    options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional(),
  }),
  z.object({ type: z.literal('prompt_end'), promptId: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]).meta({ id: 'LoginEvent' });
export type LoginEvent = z.infer<typeof LoginEventSchema>;

export const ImportSessionSchema = z.object({ path: z.string().min(1), cwd: z.string().min(1) }).strict().meta({ id: 'ImportSession' });

// ---- query of the Files panel

/** `GET /api/workspaces/:id/tree?dir=&ignored=`. */
export const FileTreeQuerySchema = z.object({ dir: z.string().optional(), ignored: QueryFlagSchema.optional() });

export const TrustDecisionResultSchema = TrustStateSchema.extend({ reopened: z.number().int(), running: z.number().int() }).meta({ id: 'TrustDecisionResult' });
export type TrustDecisionResult = z.infer<typeof TrustDecisionResultSchema>;
