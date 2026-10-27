import { z } from 'zod';

/** First-run onboarding and provider setup: what `GET /api/setup` finds and the small POSTs of the flow's cards. */

/** Where a provider's credential lives; the UI shows this word beside every credential. */
export const CredentialStoreSchema = z.enum(['auth.json', 'keychain', 'command', 'environment', 'models.json']);
export type CredentialStore = z.infer<typeof CredentialStoreSchema>;

export const SetupAuthEntrySchema = z.object({
  provider: z.string(),
  type: z.enum(['api_key', 'oauth']),
  store: CredentialStoreSchema,
});
export type SetupAuthEntry = z.infer<typeof SetupAuthEntrySchema>;

export const LocalServerSchema = z.object({
  /** `llama-swap` and `llama.cpp` answer on the same port with the same API; `ollama` has its own listing; `openai` is a server the user pointed at. */
  kind: z.enum(['llama-swap', 'ollama', 'openai']),
  name: z.string(),
  /** The OpenAI-compatible base URL pi would use, e.g. `http://127.0.0.1:8080/v1`. */
  baseUrl: z.string(),
  models: z.array(z.string()),
});
export type LocalServer = z.infer<typeof LocalServerSchema>;

export const OnboardingStateSchema = z.object({
  /** `completed`: the user reached the end (or used the fast path); `skipped`: they left it. */
  state: z.enum(['completed', 'skipped']),
  at: z.number(),
}).meta({ id: 'OnboardingState' });
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const SetupInfoSchema = z.object({
  os: z.object({ platform: z.string(), arch: z.string(), release: z.string() }),
  /** The pi this app runs sessions with and where it came from. */
  pi: z.object({ version: z.string(), source: z.enum(['env', 'managed', 'bundled']) }),
  /** A `pi` command on PATH, if there is one: what the terminal uses. */
  pathPi: z.object({ found: z.boolean(), path: z.string().optional(), version: z.string().optional() }),
  agentDir: z.object({
    path: z.string(),
    exists: z.boolean(),
    /** Stored credentials by provider, with where each one lives. Never the credential. */
    auth: z.array(SetupAuthEntrySchema),
    hasModelsJson: z.boolean(),
    hasSettings: z.boolean(),
    /** Session files pi wrote in `sessions/` (any folder). */
    sessionCount: z.number().int(),
  }),
  /** The providers that have at least one model that can be used right now. */
  providers: z.array(z.object({ id: z.string(), name: z.string(), models: z.number().int(), source: z.string().optional() })),
  localServers: z.array(LocalServerSchema),
  /** No provider has a usable model: the onboarding opens by itself (unless it was skipped). */
  needsSetup: z.boolean(),
  /** `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) already works: the Welcome card offers the fast path. */
  existingSetupWorks: z.boolean(),
  onboarding: OnboardingStateSchema.optional(),
  /** `PI_KIT_SKIP_ONBOARDING` is set (the tests): nothing opens by itself. */
  autoOpenOff: z.boolean(),
  /** The proxy host the backend's requests use (`HTTPS_PROXY`), without credentials. */
  proxy: z.string().optional(),
}).meta({ id: 'SetupInfo' });
export type SetupInfo = z.infer<typeof SetupInfoSchema>;

// ---- local models

export const LocalTestSchema = z.object({ baseUrl: z.string().min(1).max(500) }).strict().meta({ id: 'LocalTest' });
export const LocalTestResultSchema = z.object({
  ok: z.boolean(),
  kind: z.enum(['llama-swap', 'ollama', 'openai']).optional(),
  baseUrl: z.string(),
  models: z.array(z.string()),
  error: z.string().optional(),
}).meta({ id: 'LocalTestResult' });
export type LocalTestResult = z.infer<typeof LocalTestResultSchema>;

export const LocalSaveSchema = z
  .object({
    /** The provider id written into `models.json`; letters, digits, `-` and `_`. */
    provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    baseUrl: z.string().min(1).max(500),
    models: z.array(z.string().min(1).max(200)).min(1).max(200),
  })
  .strict().meta({ id: 'LocalSave' });
export const LocalSaveResultSchema = z.object({ provider: z.string(), models: z.number().int(), path: z.string() }).meta({ id: 'LocalSaveResult' });
export type LocalSaveResult = z.infer<typeof LocalSaveResultSchema>;

// ---- scratch folder and the "pi is ready" check

export const ScratchFolderSchema = z.object({ path: z.string() }).meta({ id: 'ScratchFolder' });
export type ScratchFolder = z.infer<typeof ScratchFolderSchema>;

export const ReadyCheckSchema = z.object({ provider: z.string().min(1), modelId: z.string().min(1) }).strict().meta({ id: 'ReadyCheck' });
export const ReadyResultSchema = z.object({
  ok: z.boolean(),
  /** `provider/modelId` the request went to. */
  model: z.string(),
  message: z.string(),
  ms: z.number().int(),
}).meta({ id: 'ReadyResult' });
export type ReadyResult = z.infer<typeof ReadyResultSchema>;

/** `POST /api/setup/state`. */
export const OnboardingStateRequestSchema = z.object({ state: OnboardingStateSchema.shape.state }).strict().meta({ id: 'OnboardingStateRequest' });


export const LiteLlmModelSchema = z.object({
  id: z.string(), name: z.string(), contextWindow: z.number().optional(), maxTokens: z.number().optional(),
  reasoning: z.boolean().optional(), vision: z.boolean().optional(), costInput: z.number().optional(), costOutput: z.number().optional(),
}).meta({ id: 'LiteLlmModel' });
export type LiteLlmModel = z.infer<typeof LiteLlmModelSchema>;
export const LiteLlmConnectionSchema = z.object({
  baseUrl: z.string(), configured: z.boolean(), hasApiKey: z.boolean(), models: z.array(LiteLlmModelSchema),
}).meta({ id: 'LiteLlmConnection' });
export type LiteLlmConnection = z.infer<typeof LiteLlmConnectionSchema>;
export const LiteLlmConnectSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  // Omitted reuses the saved key at the same URL; empty explicitly disables authentication.
  apiKey: z.string().max(8192).refine((key) => !key.trim().startsWith('!') && !/[\r\n]/.test(key), 'Enter a literal API key.').optional(),
}).strict().meta({ id: 'LiteLlmConnect' });
export type LiteLlmConnect = z.infer<typeof LiteLlmConnectSchema>;
