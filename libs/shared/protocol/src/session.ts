import { z } from 'zod';

/** REST shapes for the per-thread session actions (model, compact, reload, export, stats, bash). */

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const ModelInfoSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number(),
  reasoning: z.boolean(),
  /** USD per million tokens. */
  costInput: z.number().optional(),
  costOutput: z.number().optional(),
  /** The effort levels this model accepts (pi's `getSupportedThinkingLevels`): `["off"]` for a model that does not think. */
  levels: z.array(ThinkingLevelSchema),
  /** An extension's virtual model: a router that picks a physical model per request. */
  virtual: z.boolean().optional(),
  /** Pinned: in the cycling set (`enabledModels` in pi's settings, "scoped models" before): ⌘⇧M flips between these. */
  pinned: z.boolean().optional(),
  /** pi's default model for new threads (`defaultProvider` / `defaultModel` in the settings). */
  default: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ModelRefSchema = z.object({ provider: z.string(), id: z.string(), thinkingLevel: ThinkingLevelSchema.optional() });
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** How a provider is signed in, for the heading of its group in the model picker. */
export const ModelProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `subscription` (an OAuth sign-in to a plan), `api-key` (stored), `environment` (a key found in the environment), `local` (a server on this machine or network), else `other`. */
  kind: z.enum(['subscription', 'api-key', 'environment', 'local', 'other']),
  /** `host:port` of a local server. */
  address: z.string().optional(),
}).meta({ id: 'ModelProvider' });
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/** `GET /api/models?thread=<id>`: what the model picker shows. */
export const ModelListSchema = z.object({
  models: z.array(ModelInfoSchema),
  /** The providers of those models in the order of their groups, with how each is signed in. */
  providers: z.array(ModelProviderSchema),
  current: z.object({ provider: z.string(), id: z.string() }).nullable(),
  thinkingLevel: ThinkingLevelSchema,
  /** Levels the current model accepts; empty when it has no reasoning. */
  thinkingLevels: z.array(ThinkingLevelSchema),
  /** The cycling scope in cycling order (empty: ⌘⇧M cycles every available model, as pi's Ctrl+P does). */
  pinned: z.array(ModelRefSchema),
  /** What a new thread starts with, from pi's settings. */
  defaults: z.object({ provider: z.string().optional(), id: z.string().optional(), thinkingLevel: ThinkingLevelSchema.optional() }),
}).meta({ id: 'ModelList' });
export type ModelList = z.infer<typeof ModelListSchema>;

/** ⌘⇧M / ⌘⇧E: pi's `cycleModel()` (pinned models, else all available) and `cycleThinkingLevel()`. */
export const CycleSchema = z.object({ target: z.enum(['model', 'thinking']), direction: z.enum(['forward', 'backward']).optional() }).strict();
export type Cycle = z.infer<typeof CycleSchema>;

export const PatchModelSchema = z
  .object({ provider: z.string().min(1), modelId: z.string().min(1), thinkingLevel: ThinkingLevelSchema, cycle: CycleSchema })
  .partial()
  .strict()
  .refine((v) => (v.provider === undefined) === (v.modelId === undefined), 'provider and modelId go together')
  .refine((v) => v.cycle === undefined || (v.provider === undefined && v.thinkingLevel === undefined), 'cycle stands alone').meta({ id: 'PatchModel' });
export type PatchModel = z.infer<typeof PatchModelSchema>;

export const CompactRequestSchema = z.object({ instructions: z.string().trim().min(1).optional() }).strict().meta({ id: 'CompactRequest' });

/** `GET /api/threads/:id/stats` (pi `getSessionStats()` plus the context window and model). */
export const SessionStatsSchema = z.object({
  sessionId: z.string(),
  sessionFile: z.string().nullable(),
  userMessages: z.number(),
  assistantMessages: z.number(),
  toolCalls: z.number(),
  toolResults: z.number(),
  totalMessages: z.number(),
  tokens: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }),
  cost: z.number(),
  /** Estimated tokens in context; null right after compaction, before the next response. */
  contextTokens: z.number().nullable(),
  contextWindow: z.number().nullable(),
  model: z.object({ provider: z.string(), id: z.string(), name: z.string() }).nullable(),
  thinkingLevel: ThinkingLevelSchema,
  autoCompaction: z.boolean(),
  /** Context size (tokens) above which pi compacts on its own: window minus the reserve; null when auto-compaction is off or the window unknown. */
  compactionThreshold: z.number().nullable(),
  streaming: z.boolean(),
  /** An extension dialog is waiting for an answer, so the session is blocked. */
  waitingForAnswer: z.boolean(),
  cwd: z.string(),
}).meta({ id: 'SessionStats' });
export type SessionStats = z.infer<typeof SessionStatsSchema>;

/** What a piece of the context is: a system prompt section, a tool definition, a compaction summary, a skill block, a message, a tool call or result, an extension's note. */
export const ContextKindSchema = z.enum(['system', 'tool', 'summary', 'skill', 'user', 'assistant', 'thinking', 'toolCall', 'toolResult', 'extension']);
export type ContextKind = z.infer<typeof ContextKindSchema>;
/** One piece of what the model sees, with where it came from and what it costs (an estimate: characters over four, images as pi counts them). */
export const ContextItemSchema = z.object({
  id: z.string(),
  kind: ContextKindSchema,
  /** The section's or tool's name, the skill, the first line of a message. */
  label: z.string(),
  /** Who put it there: `pi`, `extension:<name>`, `skill:<name>`, `tool:<name>`, `user`, `model`, `compaction`; null when not known. */
  source: z.string().nullable(),
  tokens: z.number(),
  chars: z.number(),
  /** The text, up to a few thousand characters; `truncated` says the rest was cut. */
  text: z.string(),
  truncated: z.boolean(),
  /** The turn (1-based) the message belongs to; null for the prompt and the tools. */
  turn: z.number().nullable(),
}).meta({ id: 'ContextItem' });
export type ContextItem = z.infer<typeof ContextItemSchema>;
export const ContextGroupSchema = z.object({ kind: ContextKindSchema, tokens: z.number(), count: z.number() }).meta({ id: 'ContextGroup' });
/** The context of a thread's session, piece by piece (the context inspector of the Session panel). */
export const SessionContextSchema = z.object({
  /** What the model reported for the last request; null before the first answer or right after a compaction. */
  contextTokens: z.number().nullable(),
  contextWindow: z.number().nullable(),
  /** The sum of the items' estimates. */
  estimatedTokens: z.number(),
  model: z.object({ provider: z.string(), id: z.string(), name: z.string() }).nullable(),
  groups: z.array(ContextGroupSchema),
  items: z.array(ContextItemSchema),
}).meta({ id: 'SessionContext' });
export type SessionContext = z.infer<typeof SessionContextSchema>;

export const BashRequestSchema = z.object({ command: z.string().min(1), excludeFromContext: z.boolean().optional() }).strict().meta({ id: 'BashRequest' });
export type BashRequest = z.infer<typeof BashRequestSchema>;

export const ExportRequestSchema = z.object({ path: z.string().min(1).optional() }).strict().meta({ id: 'ExportRequest' });
export const ExportResultSchema = z.object({
  path: z.string(),
  format: z.enum(['html', 'jsonl']),
  /** How many lines (JSONL) or blobs (HTML) had a key shape masked before the file was kept. */
  redacted: z.number().int().optional(),
}).meta({ id: 'ExportResult' });
export type ExportResult = z.infer<typeof ExportResultSchema>;

export const FileMatchSchema = z.object({ path: z.string(), dir: z.boolean().optional() }).meta({ id: 'FileMatch' });
export type FileMatch = z.infer<typeof FileMatchSchema>;

/** `GET /api/models?thread=<id>`: the model list belongs to a thread (its session decides which models are available). */
export const ModelListQuerySchema = z.object({ thread: z.string().min(1) });

/** What compaction answers with: how large the context was and the summary that replaced it. */
export const CompactResultSchema = z.object({ tokensBefore: z.number(), summary: z.string() }).meta({ id: 'CompactResult' });
export type CompactResult = z.infer<typeof CompactResultSchema>;

/** `POST /api/threads/:id/reload`: how many commands the session has after the reload. */
export const ReloadResultSchema = z.object({ commands: z.number().int() }).meta({ id: 'ReloadResult' });
export type ReloadResult = z.infer<typeof ReloadResultSchema>;

/** `GET /api/changelog`: pi's own changelog. */
export const ChangelogSchema = z.object({ version: z.string(), text: z.string() }).meta({ id: 'Changelog' });
export type Changelog = z.infer<typeof ChangelogSchema>;

/** `GET /api/workspaces/:id/files?q=&limit=`: `@file` completion. */
export const FilesQuerySchema = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
