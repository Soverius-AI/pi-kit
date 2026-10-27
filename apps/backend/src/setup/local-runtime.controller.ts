import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LlamaRuntimeUpdatesSchema, type LlamaRuntimeUpdates,
  LocalCatalogQuerySchema, LocalCatalogSchema, LocalDownloadSchema, LocalHardwareQuerySchema, LocalHardwareSchema, LocalReadConfigSchema, LocalConfigFileSchema, LocalConfigFileQuerySchema, LocalConfigSaveSchema,
  LocalModelOptionsQuerySchema, LocalModelOptionsSchema, LocalModelOptionsSaveSchema, type LocalModelOptions,
  LocalModelReloadSchema,
  LocalStorageSchema, LocalStorageChangeSchema, LocalRemoveModelSchema, LocalRemoveFileSchema, LocalRegisterSchema, LocalInstallSchema, LocalRuntimeJobSchema, LocalRuntimeStatusSchema,
  LocalStartSchema, LocalAutostartSchema, LocalDoctorSchema, LocalRepairSchema, ManagedLlamaSwapSchema, LocalDoctorQuerySchema, type LocalDoctor, type ManagedLlamaSwap,
  type LocalConfigFile, type LocalCatalog, type LocalHardware, type LocalRuntimeJob, type LocalRuntimeStatus, type LocalStorage, type LocalStorageChange,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../contract';
import { LocalModelCatalogService } from './local-model-catalog.service';
import { LocalRuntimeService } from './local-runtime.service';

/**
 * `setup/local-runtime`: local models on this machine. Hardware and installed tools, the llama-swap config and its
 * per-model options, the download catalog, installs and downloads as cancellable jobs, the managed llama-swap
 * (start, stop, autostart), doctor and repair, and the storage of model files.
 */
@ApiTags('setup')
@Controller('setup/local-runtime')
export class LocalRuntimeController {
  constructor(private readonly catalog: LocalModelCatalogService, private readonly runtime: LocalRuntimeService) {}

  @Get('runtime-updates')
  @ApiOperation({ summary: 'Check configured llama.cpp runtimes for updates', description: 'Reads the actual llama-server executables used by detected llama-swap models and compares their build numbers with the latest official release. Never installs updates or restarts models.' })
  @Responds(LlamaRuntimeUpdatesSchema)
  runtimeUpdates(): Promise<LlamaRuntimeUpdates> { return this.runtime.checkRuntimeUpdates(); }

  @Get('hardware')
  @ApiOperation({ summary: 'Inspect local model hardware and installed tools', description: 'Detects memory, disk, acceleration, tools, existing servers, llama-swap YAML configurations and bounded GGUF model folders. Configured models are read even when the engine is stopped. Never installs or downloads a model or starts a server.' })
  @Responds(LocalHardwareSchema)
  @Fails({ 400: 'The selected directory is not readable.' })
  hardware(@Query({ schema: LocalHardwareQuerySchema }) query: z.infer<typeof LocalHardwareQuerySchema>): Promise<LocalHardware> { return this.runtime.detect(query.directory); }

  @Post('config')
  @HttpCode(200)
  @ApiOperation({ summary: 'Select an existing llama-swap config', description: 'Selects the existing llama-swap YAML that downloads update, and migrates previously downloaded models into it. Preserves existing entries, comments and engine options. An empty path returns to automatic config discovery. Never starts another server.' })
  @Responds(LocalHardwareSchema)
  @Fails({ 400: 'The config is not a readable valid llama-swap YAML file.' })
  readConfig(@Body({ schema: LocalReadConfigSchema }) body: z.infer<typeof LocalReadConfigSchema>): Promise<LocalHardware> { return this.runtime.readConfig(body.path, body.directory); }

  @Get('config-file')
  @ApiOperation({ summary: 'Open a detected llama-swap YAML config', description: 'Reads the detected file with an optimistic version for editing. Invalid YAML remains editable. Never executes commands.' })
  @Responds(LocalConfigFileSchema)
  @Fails({ 400: 'The config was not detected.' })
  configFile(@Query({ schema: LocalConfigFileQuerySchema }) query: z.infer<typeof LocalConfigFileQuerySchema>): Promise<LocalConfigFile> { return this.runtime.configFile(query.path); }

  @Post('config-file')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save llama-swap YAML', description: 'Validates YAML and atomically updates the detected file, preserving permissions and refusing concurrent edits. Does not run or restart llama-swap.' })
  @Responds(LocalConfigFileSchema)
  @Fails({ 400: 'The YAML is invalid.', 409: 'The file changed or another local action is running.' })
  saveConfigFile(@Body({ schema: LocalConfigSaveSchema }) body: z.infer<typeof LocalConfigSaveSchema>): Promise<LocalConfigFile> { return this.runtime.saveConfigFile(body); }

  @Get('model-options')
  @ApiOperation({ summary: 'Read configured model settings', description: 'Reads per-model engine and idle-unload options from a detected llama-swap config without running its launcher.' })
  @Responds(LocalModelOptionsSchema)
  @Fails({ 400: 'The model or config cannot be edited with the form.' })
  modelOptions(@Query({ schema: LocalModelOptionsQuerySchema }) query: z.infer<typeof LocalModelOptionsQuerySchema>): Promise<LocalModelOptions> { return this.runtime.modelOptions(query.path, query.model); }

  @Post('model-options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save configured model settings', description: 'Updates only changed fields in the existing YAML, preserving other arguments, macros, comments and models. Refuses concurrent changes. Options apply when the engine next loads the model; does not restart it.' })
  @Responds(LocalModelOptionsSchema)
  @Fails({ 400: 'A model option is invalid or unsupported.', 409: 'The config changed or another local action is running.' })
  saveModelOptions(@Body({ schema: LocalModelOptionsSaveSchema }) body: z.infer<typeof LocalModelOptionsSaveSchema>): Promise<LocalModelOptions> { return this.runtime.saveModelOptions(body); }

  @Post('model-reload')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reload a model through the existing llama-swap instance', description: 'Starts an observed, cancellable job. Revalidates the config version and running process identity, requests its config reload and loads the selected model through its API. Confirms readiness. Config reload can unload other models or interrupt active requests. Never starts another llama-swap instance.' })
  @Responds(LocalRuntimeJobSchema)
  @Fails({ 409: 'Another local action is running.' })
  reloadModel(@Body({ schema: LocalModelReloadSchema }) body: z.infer<typeof LocalModelReloadSchema>): LocalRuntimeJob { return this.runtime.reloadModel(body); }

  @Get('models')
  @ApiOperation({ summary: 'Find local model downloads that fit the machine', description: 'Reads public Hugging Face model metadata and pins candidate files by revision, byte count and SHA-256. Memory fit is an estimate, never an invented speed measurement.' })
  @Responds(LocalCatalogSchema)
  models(@Query({ schema: LocalCatalogQuerySchema }) query: z.infer<typeof LocalCatalogQuerySchema>): Promise<LocalCatalog> { return this.catalog.search(query.query, query.contextTokens); }

  @Get()
  @ApiOperation({ summary: 'Read local setup progress', description: 'The backend owns the current job and managed server independently of the open wizard.' })
  @Responds(LocalRuntimeStatusSchema)
  async status(): Promise<LocalRuntimeStatus> { await this.runtime.refreshManaged(); return this.runtime.status(); }

  @Post('start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start llama-swap with the selected config', description: 'Starts the installed llama-swap with the selected (or given) config on the loopback listener and waits until it answers. pi-kit owns that process: it ends with the app, and Stop ends it. Refused while another server answers on the listener. `autostart` saves whether it starts with the app.' })
  @Responds(ManagedLlamaSwapSchema)
  @Fails({ 400: 'llama-swap is not installed, the config cannot be used, or the process did not answer in time.', 409: 'llama-swap already runs, or something else answers on the listener.' })
  start(@Body({ schema: LocalStartSchema }) body: z.infer<typeof LocalStartSchema>): Promise<ManagedLlamaSwap> { return this.runtime.startManaged(body); }

  @Post('stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the llama-swap pi-kit started', description: 'Ends the managed process and its model servers, and forgets the start-with-app choice. A llama-swap pi-kit did not start is never touched.' })
  @Responds(ManagedLlamaSwapSchema)
  stop(): Promise<ManagedLlamaSwap> { return this.runtime.stopManaged(); }

  @Post('autostart')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start llama-swap when pi-kit starts', description: 'Saves whether pi-kit starts llama-swap with the selected config when it starts; answers with the local setup status.' })
  @Responds(LocalRuntimeStatusSchema)
  @Fails({ 400: 'No llama-swap config is selected.' })
  autostart(@Body({ schema: LocalAutostartSchema }) body: z.infer<typeof LocalAutostartSchema>): LocalRuntimeStatus { return this.runtime.setAutostart(body.enabled); }

  @Get('doctor')
  @ApiOperation({ summary: 'Check what keeps the selected llama-swap config from running', description: 'Reads the selected (or given) config and reports missing tools, invalid YAML, entries whose model file is gone and launchers that no longer exist, each marked fixable or not. Nothing is changed.' })
  @Responds(LocalDoctorSchema)
  doctor(@Query({ schema: LocalDoctorQuerySchema }) query: z.infer<typeof LocalDoctorQuerySchema>): Promise<LocalDoctor> { return this.runtime.doctor(query.path); }

  @Post('repair')
  @HttpCode(200)
  @ApiOperation({ summary: 'Repair the selected llama-swap config', description: 'Applies the fixable findings of the doctor: removes entries whose model file is missing and points missing llama-server launchers at the installed one. Every other line of the YAML is kept; the version must match the doctor report.' })
  @Responds(LocalDoctorSchema)
  @Fails({ 400: 'The YAML is invalid.', 409: 'The config changed since it was checked, or a download is running.' })
  repair(@Body({ schema: LocalRepairSchema }) body: z.infer<typeof LocalRepairSchema>): Promise<LocalDoctor> { return this.runtime.repair(body); }

  @Post('install')
  @HttpCode(200)
  @ApiOperation({ summary: 'Install selected local inference tools', description: 'Starts an explicit cancellable Homebrew job for llama.cpp and/or the official llama-swap tap; reuses already installed tools.' })
  @Responds(LocalRuntimeJobSchema)
  @Fails({ 409: 'Another local setup job is still running.' })
  install(@Body({ schema: LocalInstallSchema }) body: z.infer<typeof LocalInstallSchema>): LocalRuntimeJob { return this.runtime.install(body.tools); }

  @Post('download')
  @HttpCode(200)
  @ApiOperation({ summary: 'Download a selected GGUF model', description: 'Requires explicit acceptance, a catalogue selection and enough disk space. Verifies pinned size/SHA-256 and atomically publishes the model; failures clean up partial files.' })
  @Responds(LocalRuntimeJobSchema)
  @Fails({ 409: 'Another local setup job is still running.' })
  download(@Body({ schema: LocalDownloadSchema }) body: z.infer<typeof LocalDownloadSchema>): LocalRuntimeJob { return this.runtime.download(body.selection); }

  @Post('retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry the last interrupted local-model action', description: 'Uses the saved exact file and immutable revision, or the saved setup choices. Works after an app restart.' })
  @Responds(LocalRuntimeJobSchema)
  @Fails({ 400: 'The job has no saved retry details.', 409: 'Another local action is running.' })
  retry(): LocalRuntimeJob { return this.runtime.retry(); }

  @Post('dismiss')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dismiss a finished local-model job', description: 'Clears the finished status card without deleting model files.' })
  @Responds(LocalRuntimeStatusSchema)
  @Fails({ 409: 'The job is still running.' })
  dismiss(): LocalRuntimeStatus { return this.runtime.dismiss(); }

  @Get('storage')
  @ApiOperation({ summary: 'Inspect local-model disk usage', description: 'Reports actual free space and owned incomplete downloads or corrupt backups.' })
  @Responds(LocalStorageSchema)
  storage(): Promise<LocalStorage> { return this.runtime.storage(); }

  @Post('register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add an installed model to llama-swap', description: 'Adds the file to the selected existing llama-swap config while preserving its other entries and options. Does not start a server or run inference.' })
  @Responds(LocalRuntimeStatusSchema)
  @Fails({ 409: 'Another local action is running.' })
  register(@Body({ schema: LocalRegisterSchema }) body: z.infer<typeof LocalRegisterSchema>): Promise<LocalRuntimeStatus> { return this.runtime.register(body.modelId); }

  @Post('models/remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an installed local-model file', description: 'Requires confirmation and a previously discovered model ID. Removes tracked config entries for this file and deletes it, preserving unrelated models and the existing llama-swap service.' })
  @Responds(LocalStorageChangeSchema)
  @Fails({ 400: 'The model is no longer present.', 409: 'Another local action is running.' })
  removeModel(@Body({ schema: LocalRemoveModelSchema }) body: z.infer<typeof LocalRemoveModelSchema>): Promise<LocalStorageChange> { return this.runtime.removeModel(body.modelId); }

  @Post('storage/remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an incomplete or corrupt model file', description: 'Deletes only an owned file from the storage inventory, identified by its opaque ID.' })
  @Responds(LocalStorageChangeSchema)
  @Fails({ 400: 'The file is no longer present.', 409: 'Another local action is running.' })
  removeFile(@Body({ schema: LocalRemoveFileSchema }) body: z.infer<typeof LocalRemoveFileSchema>): Promise<LocalStorageChange> { return this.runtime.removeFile(body.id); }

  @Post('cleanup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove incomplete model downloads', description: 'Reclaims owned interrupted partial files while keeping completed models and corrupt backups. The active job must finish cleanup first.' })
  @Responds(LocalStorageChangeSchema)
  @Fails({ 409: 'Another local action is running.' })
  cleanup(): Promise<LocalStorageChange> { return this.runtime.cleanup(); }

  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel local setup', description: 'Cancels the active job and waits for cleanup before a retry can start. Existing external model servers are unaffected.' })
  @Responds(LocalRuntimeStatusSchema)
  cancel(): LocalRuntimeStatus { return this.runtime.cancel(); }

}
