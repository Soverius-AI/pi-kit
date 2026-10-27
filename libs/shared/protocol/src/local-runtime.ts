import { z } from 'zod';
import { LocalServerSchema } from './setup';

export const LlamaRuntimeUpdatesSchema = z.object({
  runtimes: z.array(z.object({ path: z.string(), models: z.array(z.string()), version: z.string().optional(), source: z.string(), status: z.enum(['unknown', 'update-available', 'current', 'newer-build']), guidance: z.string() })),
  checkedAt: z.number(), releasesUrl: z.string(), latest: z.string().optional(), error: z.string().optional(),
}).meta({ id: 'LlamaRuntimeUpdates' });
export type LlamaRuntimeUpdates = z.infer<typeof LlamaRuntimeUpdatesSchema>;

export const LocalToolSchema = z.object({
  id: z.enum(['llama-server', 'llama-bench', 'llama-swap', 'brew']),
  path: z.string().optional(),
  version: z.string().optional(),
}).meta({ id: 'LocalTool' });
export type LocalTool = z.infer<typeof LocalToolSchema>;

export const InstalledLocalModelSchema = z.object({ id: z.string(), path: z.string(), file: z.string(), bytes: z.number(), source: z.string().optional(), sha256: z.string().optional() }).meta({ id: 'InstalledLocalModel' });
export type InstalledLocalModel = z.infer<typeof InstalledLocalModelSchema>;

export const LocalLlamaSwapConfigSchema = z.object({
  path: z.string(), owned: z.boolean(), selected: z.boolean().optional(), source: z.string().optional(), models: z.array(z.string()), modelFiles: z.record(z.string(), z.string()).optional(), baseUrl: z.string().optional(), error: z.string().optional(),
}).meta({ id: 'LocalLlamaSwapConfig' });
export type LocalLlamaSwapConfig = z.infer<typeof LocalLlamaSwapConfigSchema>;
export const LocalReadConfigSchema = z.object({ path: z.string().max(2000), directory: z.string().min(1).max(2000).optional() }).strict().meta({ id: 'LocalReadConfig' });

export const LocalConfigFileQuerySchema = z.object({ path: z.string().min(1).max(2000) });
export const LocalConfigFileSchema = z.object({ path: z.string(), text: z.string(), version: z.string(), mtime: z.number() }).meta({ id: 'LocalConfigFile' });
export type LocalConfigFile = z.infer<typeof LocalConfigFileSchema>;
export const LocalConfigSaveSchema = z.object({ path: z.string().min(1).max(2000), text: z.string().max(2_000_000), version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().meta({ id: 'LocalConfigSave' });

export const LocalModelOptionValuesSchema = z.object({
  name: z.string().max(200).nullable(),
  ttl: z.number().int().min(-1).max(31_536_000).nullable(),
  context: z.number().int().min(0).max(16_777_216).nullable(),
  gpuLayers: z.union([z.number().int().min(-1).max(1_000_000), z.enum(['auto', 'all'])]).nullable(),
  threads: z.number().int().min(-1).max(4096).nullable(),
  parallel: z.number().int().min(-1).max(4096).nullable(),
  flashAttention: z.enum(['on', 'off', 'auto']).nullable(),
  temperature: z.number().min(0).max(100).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  topK: z.number().int().min(0).max(1_000_000).nullable(),
  minP: z.number().min(0).max(1).nullable(),
  specType: z.string().max(200).regex(/^[a-z0-9]+(?:[-,][a-z0-9]+)*$/).nullable(),
  specDraftMax: z.number().int().min(1).max(4096).nullable(),
  specDraftMin: z.number().int().min(0).max(4096).nullable(),
  specDraftPMin: z.number().min(0).max(1).nullable(),
  draftModel: z.string().max(2000).regex(/^[^\r\n\0]*$/).nullable(),
}).strict().meta({ id: 'LocalModelOptionValues' });
export type LocalModelOptionValues = z.infer<typeof LocalModelOptionValuesSchema>;
export const LocalModelOptionsQuerySchema = z.object({ path: z.string().min(1).max(2000), model: z.string().min(1).max(1000) });
export const LocalModelOptionsSchema = LocalModelOptionsQuerySchema.extend({
  version: z.string(), engine: z.enum(['llama.cpp', 'custom']),
  values: LocalModelOptionValuesSchema.partial(),
  supported: z.array(LocalModelOptionValuesSchema.keyof()),
  inherited: z.record(z.string(), z.string()),
  mtp: z.object({ status: z.enum(['detected', 'configured', 'no-heads', 'model-unreadable', 'engine-unverified', 'engine-unsupported']), heads: z.number().int().min(0).optional() }).optional(),
  reload: z.object({ available: z.boolean(), reason: z.string().optional(), baseUrl: z.string().optional() }).optional(),
}).meta({ id: 'LocalModelOptions' });
export type LocalModelOptions = z.infer<typeof LocalModelOptionsSchema>;
export const LocalModelOptionsSaveSchema = LocalModelOptionsQuerySchema.extend({
  version: z.string().regex(/^[a-f0-9]{64}$/), values: LocalModelOptionValuesSchema.partial(),
}).strict().meta({ id: 'LocalModelOptionsSave' });
export type LocalModelOptionsSave = z.infer<typeof LocalModelOptionsSaveSchema>;
export const LocalModelReloadSchema = LocalModelOptionsQuerySchema.extend({ version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().meta({ id: 'LocalModelReload' });
export type LocalModelReload = z.infer<typeof LocalModelReloadSchema>;

export const LocalHardwareSchema = z.object({
  platform: z.string(), arch: z.string(), cpu: z.string(), cores: z.number(),
  ramBytes: z.number(), freeRamBytes: z.number(), diskFreeBytes: z.number(),
  acceleration: z.object({ kind: z.enum(['metal', 'cuda', 'cpu']), name: z.string(), memoryBytes: z.number().optional(), sharedMemory: z.boolean() }),
  tools: z.array(LocalToolSchema), models: z.array(InstalledLocalModelSchema), servers: z.array(LocalServerSchema),
  configs: z.array(LocalLlamaSwapConfigSchema).optional(), llamaSwapConfigPath: z.string().optional(),
  installer: z.object({ supported: z.boolean(), reason: z.string(), sources: z.array(z.string()), guide: z.object({ manager: z.enum(['brew', 'apt', 'manual']), prerequisites: z.string().optional(), builds: z.array(z.object({ id: z.enum(['cpu', 'cuda', 'vulkan']), command: z.string() })), swapCommand: z.string().optional() }).optional() }),
}).meta({ id: 'LocalHardware' });
export type LocalHardware = z.infer<typeof LocalHardwareSchema>;

export const LocalModelCandidateSchema = z.object({
  id: z.string(), repository: z.string(), revision: z.string(), file: z.string(), bytes: z.number(), sha256: z.string(),
  license: z.string(), source: z.string(), downloads: z.number(),
  estimate: z.object({ contextTokens: z.number(), memoryBytes: z.number(), fitsMemory: z.boolean(), fitsDisk: z.boolean(), explanation: z.string() }),
}).meta({ id: 'LocalModelCandidate' });
export type LocalModelCandidate = z.infer<typeof LocalModelCandidateSchema>;
export const LocalCatalogSchema = z.object({ models: z.array(LocalModelCandidateSchema), notes: z.array(z.string()) }).meta({ id: 'LocalCatalog' });
export type LocalCatalog = z.infer<typeof LocalCatalogSchema>;

export const LocalMeasurementSchema = z.object({
  kind: z.enum(['http', 'llama-bench']), at: z.number(), model: z.string(), contextTokens: z.number().optional(),
  firstTokenMs: z.number().optional(), totalMs: z.number(), promptTokensPerSecond: z.number().optional(), generationTokensPerSecond: z.number().optional(),
  modelBytes: z.number().optional(), memoryBytes: z.number().optional(), memoryDescription: z.string(),
  response: z.string().optional(), toolCalling: z.enum(['passed', 'failed', 'not-tested']), imageSupport: z.enum(['passed', 'failed', 'not-tested']),
  notes: z.array(z.string()),
}).meta({ id: 'LocalMeasurement' });
export type LocalMeasurement = z.infer<typeof LocalMeasurementSchema>;

export const LocalRuntimeActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('download'), candidate: LocalModelCandidateSchema }),
  z.object({ kind: z.literal('install'), tools: z.array(z.enum(['llama.cpp', 'llama-swap'])).min(1).max(2) }),
  z.object({ kind: z.literal('start'), modelId: z.string(), autostart: z.boolean() }),
  LocalModelReloadSchema.extend({ kind: z.literal('reload') }),
]).meta({ id: 'LocalRuntimeAction' });
export type LocalRuntimeAction = z.infer<typeof LocalRuntimeActionSchema>;
export const LocalStorageFileSchema = z.object({ id: z.string(), file: z.string(), bytes: z.number(), kind: z.enum(['partial', 'corrupt']) });
export const LocalStorageSchema = z.object({ directory: z.string(), freeBytes: z.number(), files: z.array(LocalStorageFileSchema) }).meta({ id: 'LocalStorage' });
export type LocalStorage = z.infer<typeof LocalStorageSchema>;
export const LocalStorageChangeSchema = z.object({ removedBytes: z.number(), storage: LocalStorageSchema }).meta({ id: 'LocalStorageChange' });
export type LocalStorageChange = z.infer<typeof LocalStorageChangeSchema>;
export const LocalRemoveModelSchema = z.object({ modelId: z.string().min(1).max(80), accept: z.literal(true) }).strict().meta({ id: 'LocalRemoveModel' });
export const LocalRemoveFileSchema = z.object({ id: z.string().min(1).max(80), accept: z.literal(true) }).strict().meta({ id: 'LocalRemoveFile' });
export const LocalRegisterSchema = z.object({ modelId: z.string().min(1).max(80) }).strict().meta({ id: 'LocalRegister' });

export const LocalRuntimeJobSchema = z.object({
  id: z.string(), kind: z.enum(['install', 'download', 'start', 'benchmark', 'reload']), state: z.enum(['running', 'cancelling', 'complete', 'failed', 'cancelled']),
  detail: z.string(), startedAt: z.number(), finishedAt: z.number().optional(), logs: z.array(z.string()),
  receivedBytes: z.number().optional(), totalBytes: z.number().optional(), error: z.string().optional(),
  action: LocalRuntimeActionSchema.optional(), model: InstalledLocalModelSchema.optional(), server: LocalServerSchema.optional(), measurement: LocalMeasurementSchema.optional(),
}).meta({ id: 'LocalRuntimeJob' });
export type LocalRuntimeJob = z.infer<typeof LocalRuntimeJobSchema>;
/** The llama-swap process pi-kit started for the selected config: its state, where it listens, and the last lines it printed. */
export const ManagedLlamaSwapSchema = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'failed']),
  configPath: z.string(),
  listen: z.string(),
  baseUrl: z.string(),
  pid: z.number().int().optional(),
  startedAt: z.number().optional(),
  /** Why the last start failed or the process ended, in one sentence. */
  error: z.string().optional(),
  log: z.array(z.string()),
  /** The process can be started now: llama-swap is installed, the config reads and nothing else answers on the listener. */
  canStart: z.boolean(),
  /** Why it cannot be started, when it cannot. */
  reason: z.string().optional(),
}).meta({ id: 'ManagedLlamaSwap' });
export type ManagedLlamaSwap = z.infer<typeof ManagedLlamaSwapSchema>;
export const LocalAutostartSchema = z.object({ enabled: z.boolean() }).strict().meta({ id: 'LocalAutostart' });
export type LocalAutostart = z.infer<typeof LocalAutostartSchema>;
export const LocalStartSchema = z.object({ configPath: z.string().min(1).max(2000).optional(), autostart: z.boolean().optional() }).strict().meta({ id: 'LocalStart' });
export type LocalStart = z.infer<typeof LocalStartSchema>;
/** One thing the doctor found wrong with the selected llama-swap setup, and whether Repair can fix it without the editor. */
export const LocalDoctorIssueSchema = z.object({
  kind: z.enum(['tool-missing', 'config-missing', 'invalid-yaml', 'no-models', 'missing-file', 'missing-launcher', 'listener-busy']),
  model: z.string().optional(),
  detail: z.string(),
  fixable: z.boolean(),
}).meta({ id: 'LocalDoctorIssue' });
export type LocalDoctorIssue = z.infer<typeof LocalDoctorIssueSchema>;
export const LocalDoctorSchema = z.object({
  configPath: z.string(),
  /** The content hash Repair must send back, so it never writes over an edit made meanwhile. */
  version: z.string().optional(),
  issues: z.array(LocalDoctorIssueSchema),
  fixable: z.boolean(),
}).meta({ id: 'LocalDoctor' });
export type LocalDoctor = z.infer<typeof LocalDoctorSchema>;
export const LocalDoctorQuerySchema = z.object({ path: z.string().min(1).max(2000).optional() });
export const LocalRepairSchema = z.object({ configPath: z.string().min(1).max(2000), version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().meta({ id: 'LocalRepair' });
export type LocalRepair = z.infer<typeof LocalRepairSchema>;
export const LocalRuntimeStatusSchema = z.object({ engine: z.object({ configPath: z.string(), modelIds: z.array(z.string()), starting: z.boolean().optional() }).optional(), job: LocalRuntimeJobSchema.optional(), server: LocalServerSchema.optional(), error: z.string().optional(), modelId: z.string().optional(), contextTokens: z.number().optional(), autostart: z.boolean(), managed: ManagedLlamaSwapSchema.optional() }).meta({ id: 'LocalRuntimeStatus' });
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;

// Query objects stay inline so Swagger expands their properties into individual URL parameters.
export const LocalHardwareQuerySchema = z.object({ directory: z.string().min(1).max(2000).optional() });
export const LocalCatalogQuerySchema = z.object({ query: z.string().max(100).optional(), contextTokens: z.coerce.number().int().min(512).max(32768).default(8192) });
export const LocalInstallSchema = z.object({ tools: z.array(z.enum(['llama.cpp', 'llama-swap'])).min(1).max(2) }).strict().meta({ id: 'LocalInstall' });
export const LocalDownloadSchema = z.object({ selection: z.string().min(1).max(80), accept: z.literal(true) }).strict().meta({ id: 'LocalDownload' });
