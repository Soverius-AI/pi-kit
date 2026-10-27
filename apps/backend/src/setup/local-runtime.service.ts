import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LocalRuntimeJobSchema, type LocalDoctor, type LocalRepair, type LocalStart, type ManagedLlamaSwap, type LocalModelReload, type LocalModelOptions, type LocalModelOptionsSave, type LocalRuntimeAction, type LocalModelCandidate, type LocalHardware, type LocalRuntimeJob, type LocalRuntimeStatus, type LocalStorage, type LocalStorageChange, type LocalConfigFile } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { agentDirOf } from '../pi/pi-resolution';
import { refreshExistingLocalProviders, removeLegacyLocalProvider } from './local-models';
import { defaultProbes, probeLocalServers } from './detect';
import { MetaRepository } from '../db/meta.repository';
import { runProcess } from '../pi/process-runner';
import { LocalHardwareService, localExecutable } from './local-hardware.service';
import { LocalLlamaSwapService } from './local-llama-swap.service';
import { LocalLlamaSwapProcessService } from './local-llama-swap-process.service';
import { LocalModelCatalogService } from './local-model-catalog.service';
import { LocalDownloadCleanupError, LocalModelFilesService } from './local-model-files.service';

import { checkLlamaRuntimeUpdates } from './llama-runtime-updates';

type JobProgress = (patch: Partial<LocalRuntimeJob>) => void;

/** One backend-owned setup job at a time; leaving a card never cancels an installation or download. */
@Injectable()
export class LocalRuntimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LocalRuntimeService.name);
  private job?: LocalRuntimeJob;
  private abort?: AbortController;
  private pending?: Promise<void>;
  private stopping = false;
  private mutating = false;
  private lastPersisted = 0;
  private persistenceError?: string;

  constructor(
    private readonly hardware: LocalHardwareService,
    private readonly catalog: LocalModelCatalogService,
    private readonly files: LocalModelFilesService,
    private readonly swap: LocalLlamaSwapService,
    private readonly meta: MetaRepository,
    @Inject(CONFIG) private readonly config: Pick<BackendConfig, 'localRuntime'>,
    readonly managed: LocalLlamaSwapProcessService,
  ) {
    const previous = LocalRuntimeJobSchema.safeParse(meta.getSetting('local-runtime-job'));
    if (previous.success) this.job = previous.data;
    // The providers learn the managed llama-swap's models as soon as it answers (the existing-provider refresh).
    managed.onChange((state) => { if (state === 'running') void this.refreshProviders().catch(() => undefined); });
  }

  onApplicationBootstrap(): void {
    if (this.job?.state === 'running' || this.job?.state === 'cancelling') {
      this.job = { ...this.job, state: 'failed', finishedAt: Date.now(), detail: 'The previous setup was interrupted.', error: 'The app stopped before this job finished. Retry the action; incomplete downloads are not used.' };
      this.persist(true);
    }
    // "Start llama-swap with pi-kit": the saved choice starts the user's own config; the older private-engine recipe is dropped.
    void this.managed.startSaved();
    const owner = this.meta.getSetting('local-runtime-provider');
    if (owner) {
      try { removeLegacyLocalProvider(agentDirOf(process.env), owner); this.meta.setSetting('local-runtime-provider', null); }
      catch { this.logger.warn('The old private-engine provider could not be removed. Existing providers were kept.'); }
    }
  }

  checkRuntimeUpdates() { return checkLlamaRuntimeUpdates(this.swap); }

  async detect(directory?: string): Promise<LocalHardware> {
    const [facts, configs] = await Promise.all([this.hardware.detect(directory, [{ kind: 'llama-swap', name: 'llama-swap (started by pi-kit)', baseUrl: this.managed.baseUrl() }]), this.swap.readConfigs(true)]);
    return { ...facts, configs, llamaSwapConfigPath: this.swap.status().engine.configPath };
  }

  /** The managed llama-swap: start it with the selected config, stop it, see what keeps it from running, repair that. */
  async startManaged(input: LocalStart): Promise<ManagedLlamaSwap> {
    if (this.abort || this.mutating) throw new ConflictException('Another local setup action is still running. Wait or cancel it before starting llama-swap.');
    return this.managed.start(input);
  }
  stopManaged(): Promise<ManagedLlamaSwap> { return this.managed.stop(); }
  setAutostart(enabled: boolean): LocalRuntimeStatus { this.managed.setAutostart(enabled); return this.status(); }
  doctor(path?: string): Promise<LocalDoctor> { return this.swap.doctor(path); }
  repair(input: LocalRepair): Promise<LocalDoctor> { return this.exclusive(() => this.swap.repair(input)); }
  async refreshManaged(): Promise<void> { await this.managed.refresh(); }

  readConfig(path: string, directory?: string): Promise<LocalHardware> {
    return this.exclusive(async () => {
      try { await this.swap.selectConfig(path); }
      catch (error) { throw new BadRequestException(error instanceof Error && !(error as NodeJS.ErrnoException).code ? error.message : 'Could not update this llama-swap config. Check its path and permissions.'); }
      return this.detect(directory);
    });
  }

  configFile(path: string): Promise<LocalConfigFile> { return this.swap.configFile(path); }
  modelOptions(path: string, model: string): Promise<LocalModelOptions> { return this.swap.modelOptions(path, model); }
  saveModelOptions(input: LocalModelOptionsSave): Promise<LocalModelOptions> {
    return this.exclusive(() => this.swap.saveModelOptions(input));
  }
  reloadModel(input: LocalModelReload): LocalRuntimeJob {
    return this.run({ kind: 'reload', ...input }, `Preparing to reload ${input.model}…`, async (signal, progress) => {
      await this.swap.reloadModel(input, signal, (detail) => progress({ detail }));
      await this.refreshProviders();
    });
  }
  saveConfigFile(input: { path: string; text: string; version: string }): Promise<LocalConfigFile> {
    return this.exclusive(() => this.swap.saveConfigFile(input));
  }

  status(): LocalRuntimeStatus {
    return { ...this.swap.status(), ...(this.job ? { job: this.job } : {}), ...(this.persistenceError ? { error: this.persistenceError } : {}), autostart: this.managed.autostart(), managed: this.managed.status() };
  }

  private persist(force = false): void {
    if (this.stopping || !this.job || (!force && Date.now() - this.lastPersisted < 500)) return;
    this.lastPersisted = Date.now();
    try {
      this.meta.setSetting('local-runtime-job', this.job);
      this.persistenceError = undefined;
    } catch {
      if (!this.persistenceError) this.logger.warn('Local setup progress could not be saved; the active job remains available in memory.');
      this.persistenceError = 'Local setup progress could not be saved. Check free disk space; the latest status remains available in this app.';
    }
  }

  private run(action: LocalRuntimeAction, detail: string, work: (signal: AbortSignal, progress: JobProgress, log: (line: string) => void) => Promise<void>): LocalRuntimeJob {
    if (this.abort || this.stopping || this.mutating) throw new ConflictException('Another local setup action is still running. Wait or cancel it before starting another.');
    const abort = new AbortController();
    const id = randomUUID();
    this.abort = abort;
    this.job = { id, kind: action.kind, action, state: 'running', detail, startedAt: Date.now(), logs: [] };
    this.persist(true);
    const progress: JobProgress = (patch) => {
      if (this.job?.id !== id || this.stopping || (this.job.state !== 'running' && this.job.state !== 'cancelling')) return;
      this.job = { ...this.job, ...patch };
      this.persist();
    };
    const log = (line: string): void => {
      if (this.job?.id === id) progress({ logs: [...this.job.logs, line.slice(0, 1000)].slice(-80) });
    };
    this.pending = Promise.resolve().then(() => work(abort.signal, progress, log)).then(() => {
      if (this.job?.id === id) this.job = { ...this.job, state: abort.signal.aborted ? 'cancelled' : 'complete', finishedAt: Date.now(), detail: abort.signal.aborted ? 'Cancelled.' : this.job.detail };
    }).catch((error: unknown) => {
      if (this.job?.id === id) this.job = { ...this.job, state: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt: Date.now(), detail: abort.signal.aborted ? 'Cancelled.' : 'Setup could not finish.', ...(abort.signal.aborted && !(error instanceof LocalDownloadCleanupError) ? {} : { error: error instanceof Error ? error.message : String(error) }) };
    }).finally(() => {
      if (this.abort === abort) this.abort = undefined;
      this.persist(true);
    });
    return this.job;
  }

  install(tools: ('llama.cpp' | 'llama-swap')[]): LocalRuntimeJob {
    return this.run({ kind: 'install', tools }, 'Checking installed tools…', async (signal, progress, log) => {
      const facts = await this.hardware.detect();
      const requested = [...new Set(tools)];
      const missing = requested.filter((tool) => !facts.tools.some((entry) => entry.id === (tool === 'llama.cpp' ? 'llama-server' : tool) && entry.path));
      if (missing.length === 0) { await this.swap.refreshTools(); progress({ detail: 'The requested tools are already installed and will be reused.' }); return; }
      const brew = facts.tools.find((tool) => tool.id === 'brew')?.path;
      if (!facts.installer.supported || !brew) throw new Error(facts.installer.reason);
      const abort = AbortSignal.any([signal, AbortSignal.timeout(this.config.localRuntime?.installMs ?? 15 * 60_000)]);
      const execute = async (args: string[]): Promise<void> => {
        abort.throwIfAborted();
        const result = await runProcess({ command: brew, args, processGroup: true, signal: abort, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' }, onLine: log });
        abort.throwIfAborted();
        if (result.code !== 0) throw new Error(`Homebrew ${args[0]} did not complete (${result.code ?? result.signal}). Review the log, fix the cause and retry.`);
      };
      for (const tool of missing) {
        progress({ detail: `Installing ${tool} with Homebrew…` });
        if (tool === 'llama-swap') { await execute(['tap', 'mostlygeek/llama-swap']); await execute(['install', 'mostlygeek/llama-swap/llama-swap']); }
        else await execute(['install', 'llama.cpp']);
        if (!await localExecutable(tool === 'llama.cpp' ? 'llama-server' : tool)) throw new Error(`Homebrew finished but ${tool} was not found. Check its installation and detect again.`);
      }
      await this.swap.refreshTools(missing.includes('llama-swap') && !facts.servers.some((server) => server.kind === 'llama-swap'));
      progress({ detail: 'llama-swap and llama.cpp are ready. Downloads use your selected llama-swap config.' });
    });
  }

  download(selection: string): LocalRuntimeJob {
    return this.downloadCandidate(this.catalog.selection(selection));
  }

  private downloadCandidate(candidate: LocalModelCandidate): LocalRuntimeJob {
    return this.run({ kind: 'download', candidate }, 'Preparing the selected model download…', async (signal, progress) => {
      const configPath = await this.swap.prepareTarget();
      const model = await this.files.download(candidate, signal, (receivedBytes, totalBytes) => progress({ receivedBytes, totalBytes, detail: 'Downloading and verifying the selected file…' }));
      progress({ model, detail: 'Download verified. Adding the model to llama-swap…' });
      await this.swap.register(model, signal, configPath);
      await this.refreshProviders();
      progress({ model, detail: 'Downloaded and added to llama-swap.' });
    });
  }

  private async refreshProviders(): Promise<void> {
    try { refreshExistingLocalProviders(agentDirOf(process.env), await probeLocalServers([...defaultProbes(), { kind: 'llama-swap', name: 'llama-swap (started by pi-kit)', baseUrl: this.managed.baseUrl() }])); }
    catch { this.logger.warn('The config was updated, but the existing local-provider model list could not be refreshed.'); }
  }

  retry(): LocalRuntimeJob {
    const action = this.job?.action;
    if (!this.job || !['cancelled', 'failed'].includes(this.job.state) || !action) throw new BadRequestException('This older job has no saved retry details. Find the model again to start a new download.');
    if (this.job.model) this.hardware.remember(this.job.model);
    if (action.kind === 'download') return this.downloadCandidate(action.candidate);
    if (action.kind === 'install') return this.install(action.tools);
    if (action.kind === 'reload') return this.reloadModel(action);
    throw new BadRequestException('Private engine startup has been removed. Use your existing llama-swap service.');
  }

  dismiss(): LocalRuntimeStatus {
    this.assertIdle();
    this.meta.setSetting('local-runtime-job', null);
    this.job = undefined;
    return this.status();
  }

  storage(): Promise<LocalStorage> { return this.files.storage(); }

  private assertIdle(): void {
    if (this.abort || this.stopping || this.mutating) throw new ConflictException('Wait for the current local-model action to finish, or cancel it first.');
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.mutating = true;
    try { return await work(); } finally { this.mutating = false; }
  }

  register(modelId: string): Promise<LocalRuntimeStatus> {
    return this.exclusive(async () => {
      await this.swap.register(await this.hardware.model(modelId));
      await this.refreshProviders();
      return this.status();
    });
  }

  removeModel(modelId: string): Promise<LocalStorageChange> {
    return this.exclusive(async () => {
      await this.swap.unregister(modelId);
      const result = await this.files.removeModel(modelId);
      return result;
    });
  }

  removeFile(id: string): Promise<LocalStorageChange> { return this.exclusive(() => this.files.removeFile(id)); }
  cleanup(): Promise<LocalStorageChange> { return this.exclusive(() => this.files.cleanup()); }

  cancel(): LocalRuntimeStatus {
    if (this.abort && this.job) {
      this.job = { ...this.job, state: 'cancelling', detail: this.job.kind === 'reload' ? 'Stopping the reload wait. The existing instance stays running…' : 'Cancelling and cleaning up partial work…' };
      this.persist(true);
      this.abort.abort();
    }
    return this.status();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    await this.pending;
  }
}
