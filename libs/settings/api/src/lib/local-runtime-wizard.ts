import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { checkLlamaSwapYaml, modelIdentity, type InstalledLocalModel } from '@pi-kit/protocol';
import { FileEditorDialog, type EditorSource } from './file-editor';
import { LocalInstallGuide } from './local-install-guide';
import { LlamaRuntimeUpdatesPanel } from './llama-runtime-updates';
import { LocalModelSettings } from './local-model-settings';
import { PkTabs, PkTabPanel, PkScrollArea } from '@pi-kit/design-system';
import { LocalModelCatalogStore, LocalRuntimeStore } from '@pi-kit/settings/data';

/**
 * Settings › Local models (and the local step of “Get a model”): the local model library in three tabs. Installed
 * lists the GGUF files on this machine and the models the llama-swap configs serve, with the config's YAML editor and
 * the per-model settings; Download searches the catalog, checks disk capacity and shows advisory memory estimates;
 * Engines shows the llama.cpp and llama-swap tools, the doctor's answer and Start, Stop and Repair. Reads
 * `LocalModelCatalogStore` and `LocalRuntimeStore`, and shows the running job with its progress and log.
 */
@Component({
  selector: 'pk-local-runtime-wizard',
  imports: [
    DecimalPipe,
    NgTemplateOutlet,
    PkTabs,
    PkTabPanel,
    PkScrollArea,
    FileEditorDialog,
    LocalModelSettings,
    LlamaRuntimeUpdatesPanel,
    LocalInstallGuide,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './local-runtime-wizard.html',
})
export class LocalRuntimeWizard {
  protected readonly i18n = inject(Language);
  protected readonly catalog = inject(LocalModelCatalogStore);
  protected readonly runtime = inject(LocalRuntimeStore);
  protected readonly tab = signal('installed');
  protected readonly gib = 1024 ** 3;
  protected readonly estimateContext = 8192;
  protected readonly modelIdentity = modelIdentity;
  private readonly injector = inject(Injector);
  private readonly review = viewChild<ElementRef<HTMLElement>>('downloadReview');
  private readonly results = viewChild<PkScrollArea, ElementRef<HTMLElement>>('downloadResults', { read: ElementRef });
  protected readonly busy = computed(() => this.runtime.active() || this.runtime.submitting());
  protected readonly downloading = computed(
    () => this.runtime.active() && this.runtime.status()?.job?.kind === 'download',
  );
  protected readonly modelQuery = signal('');
  private readonly localFiles = computed(() => [
    ...new Map((this.catalog.hardware()?.models ?? []).map((model) => [model.path, model])).values(),
  ]);
  private readonly unconfiguredModels = computed(() => {
    const configuredFiles = new Set(this.configuredModels().flatMap((model) => (model.file ? [model.file.path] : [])));
    return this.localFiles().filter((model) => !configuredFiles.has(model.path));
  });
  protected readonly models = computed(() => {
    const query = this.modelQuery().trim().toLowerCase();
    return this.unconfiguredModels().filter(
      (model) => !query || `${model.file} ${model.path}`.toLowerCase().includes(query),
    );
  });
  protected readonly configuredModels = computed(() => {
    const servers = new Map<string, { name: string; baseUrl: string; models: Set<string> }>();
    const configs = this.catalog.hardware()?.configs ?? [];
    const files = new Map(this.localFiles().map((model) => [model.path, model]));
    for (const server of this.catalog.hardware()?.servers ?? []) {
      if (server.kind !== 'llama-swap') continue;
      const endpoint = this.serverKey(server);
      const previous = servers.get(endpoint);
      servers.set(endpoint, {
        name: server.name,
        baseUrl: server.baseUrl,
        models: new Set([...(previous?.models ?? []), ...server.models]),
      });
    }
    const liveByConfig = new Map<string, { name: string; baseUrl: string }[]>();
    const advertised = [];
    for (const [endpoint, server] of servers) {
      for (const name of server.models) {
        const candidates = configs.filter((config) => !config.error && config.models.includes(name));
        const bound = candidates.filter((config) => config.baseUrl && this.serverKey(config) === endpoint);
        // Older discoveries may lack a listener binding. Match only an unambiguous model/config/server.
        const fallback =
          candidates.length === 1 &&
          !candidates[0].baseUrl &&
          [...servers.values()].filter((entry) => entry.models.has(name)).length === 1
            ? candidates[0]
            : undefined;
        const owner = bound.length === 1 ? bound[0] : bound.length === 0 ? fallback : undefined;
        if (owner) {
          const key = modelIdentity('llama-swap:' + owner.path, name);
          const current = liveByConfig.get(key) ?? [];
          liveByConfig.set(key, [...current, server]);
        } else {
          advertised.push({
            key: modelIdentity('llama-swap:' + endpoint, name),
            name,
            server: server.name,
            location: server.baseUrl,
            endpoints: [] as string[],
            selected: false,
            fromConfig: false,
            file: undefined as InstalledLocalModel | undefined,
            state: this.i18n.t('threads.threadGroups.running'),
            running: true,
          });
        }
      }
    }
    const configured = configs.flatMap((config) =>
      [...new Set(config.models)].map((name) => {
        const live = liveByConfig.get(modelIdentity('llama-swap:' + config.path, name)) ?? [];
        return {
          key: modelIdentity('llama-swap:' + config.path, name),
          name,
          server: live.length
            ? [...new Set(live.map((server) => server.name))].join(' · ')
            : this.i18n.t('settings.modelManagement.llamaSwapConfig'),
          location: config.path,
          endpoints: live.map((server) => server.baseUrl),
          selected: !!config.selected,
          fromConfig: true,
          file: files.get(config.modelFiles?.[name] ?? ''),
          state: live.length
            ? this.i18n.t('threads.threadGroups.running')
            : this.i18n.t('settings.modelManagement.fromConfig'),
          running: live.length > 0,
        };
      }),
    );
    return [...new Map([...configured, ...advertised].map((model) => [model.key, model])).values()];
  });
  protected readonly configErrors = computed(() =>
    (this.catalog.hardware()?.configs ?? []).filter((config) => config.error),
  );
  protected readonly filteredConfiguredModels = computed(() => {
    const query = this.modelQuery().trim().toLowerCase();
    return this.configuredModels().filter(
      (model) =>
        !query ||
        `${model.name} ${model.server} ${model.location} ${model.endpoints.join(' ')} ${model.file?.file ?? ''} ${model.file?.path ?? ''}`
          .toLowerCase()
          .includes(query),
    );
  });
  protected readonly libraryCount = computed(() => this.unconfiguredModels().length + this.configuredModels().length);
  private serverKey(server: { baseUrl?: string }): string {
    const value = (server.baseUrl ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      const url = new URL(value);
      if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
      return url.href.replace(/\/+$/, '');
    } catch {
      return value;
    }
  }
  protected readonly modelBytes = computed(() => this.localFiles().reduce((bytes, model) => bytes + model.bytes, 0));
  protected readonly targetConfigPath = computed(
    () => this.catalog.hardware()?.llamaSwapConfigPath ?? this.runtime.status()?.engine?.configPath ?? '',
  );
  protected readonly hasConfigTarget = computed(() => {
    const path = this.targetConfigPath();
    return !!path && !(this.catalog.hardware()?.configs ?? []).some((config) => config.path === path && config.error);
  });
  protected readonly registered = computed(
    () =>
      new Set(
        this.runtime.status()?.engine?.configPath === this.targetConfigPath()
          ? (this.runtime.status()?.engine?.modelIds ?? [])
          : [],
      ),
  );
  protected readonly configEditor = signal<EditorSource | undefined>(undefined);
  protected readonly modelSettings = signal<{ path: string; model: string } | undefined>(undefined);
  protected modelYaml(path: string): void {
    this.modelSettings.set(undefined);
    this.editConfig(path);
  }
  protected editConfig(path: string): void {
    let version = '';
    this.configEditor.set({
      title: path,
      chips: [{ text: 'YAML' }, { text: 'llama-swap', tone: 'off' }],
      language: 'yaml',
      load: async () => {
        const file = await this.catalog.configFile(path);
        version = file.version;
        return file;
      },
      save: async (text) => {
        const file = await this.catalog.saveConfigFile(path, text, version);
        version = file.version;
        return file;
      },
      check: (text) => {
        const issue = checkLlamaSwapYaml(text);
        return issue ? { ...issue, message: this.i18n.t('settings.modelManagement.yaml.' + issue.code) } : undefined;
      },
      valid: () => this.i18n.t('settings.modelManagement.validLlamaSwapYAML'),
      saveLabel: this.i18n.t('settings.modelManagement.saveYAML'),
    });
  }
  protected chooseConfig(path: string): void {
    this.catalog.setConfigPath(path);
    void this.catalog.readConfig();
  }
  protected readonly removingModel = signal('');
  protected readonly removingFile = signal('');
  protected readonly partialBytes = computed(() =>
    (this.runtime.storage()?.files ?? [])
      .filter((file) => file.kind === 'partial')
      .reduce((sum, file) => sum + file.bytes, 0),
  );
  protected readonly partialCount = computed(
    () => this.runtime.storage()?.files.filter((file) => file.kind === 'partial').length ?? 0,
  );
  protected readonly jobFile = computed(() => {
    const job = this.runtime.status()?.job;
    return job?.action?.kind === 'download'
      ? job.action.candidate.file
      : job?.action?.kind === 'reload'
        ? job.action.model
        : job?.model?.file;
  });
  protected readonly jobRepository = computed(() => {
    const action = this.runtime.status()?.job?.action;
    return action?.kind === 'download' ? action.candidate.repository : undefined;
  });
  protected readonly jobTitle = computed(() => {
    const job = this.runtime.status()?.job;
    const action =
      job?.kind === 'download'
        ? this.i18n.t('settings.modelManagement.download')
        : job?.kind === 'reload'
          ? this.i18n.t('settings.modelManagement.modelReload')
          : job?.kind === 'install'
            ? this.i18n.t('settings.modelManagement.engineSetup')
            : 'llama-swap';
    return this.i18n.t('settings.modelManagement.jobTitle', {
      action,
      state: this.i18n.t(
        job?.state === 'cancelling'
          ? 'settings.modelManagement.isStopping'
          : job?.state === 'running'
            ? 'settings.modelManagement.inProgress'
            : job?.state === 'complete'
              ? 'settings.runtime.state.complete'
              : job?.state === 'cancelled'
                ? 'settings.runtime.state.cancelled'
                : 'settings.runtime.test.failed',
      ),
    });
  });
  protected readonly selection = signal('');
  protected readonly reviewing = signal(false);
  protected readonly candidate = computed(() =>
    this.catalog.catalog()?.models.find((model) => model.id === this.selection()),
  );
  private readonly candidateId = computed(() => this.candidate()?.id ?? '');
  protected readonly accepted = linkedSignal({ source: this.candidateId, computation: () => false });
  protected readonly estimatesCurrent = computed(
    () =>
      this.catalog.catalogContextTokens() === this.estimateContext &&
      this.catalog.catalogQuery() === this.catalog.query().trim(),
  );
  protected readonly missingTools = computed(() => {
    const tools = this.catalog.hardware()?.tools ?? [];
    const missing: ('llama.cpp' | 'llama-swap')[] = [];
    if (!tools.some((tool) => tool.id === 'llama-server' && tool.path)) missing.push('llama.cpp');
    if (!tools.some((tool) => tool.id === 'llama-swap' && tool.path)) missing.push('llama-swap');
    return missing;
  });
  protected readonly engineTools = computed(() =>
    ['llama-server', 'llama-swap'].map((id) => ({
      id,
      name: id === 'llama-server' ? 'llama.cpp' : 'llama-swap',
      tool: this.catalog.hardware()?.tools.find((tool) => tool.id === id),
    })),
  );

  /** The llama-swap pi-kit starts for the selected config, and what keeps it from running. */
  protected readonly managed = computed(() => this.runtime.managed());
  protected readonly doctor = computed(() => this.runtime.doctor());
  protected readonly swapLog = computed(() => (this.managed()?.log ?? []).slice(-12));
  /** What the doctor's answer depends on, as one string; undefined before the first detection. */
  private readonly doctorKey = computed(() => {
    const hardware = this.catalog.hardware();
    if (!hardware) return undefined;
    const config = hardware.configs?.find((entry) => entry.selected);
    const tools = hardware.tools.map((tool) => `${tool.id}=${tool.path ?? ''}`).join(',');
    return `${config?.path ?? hardware.llamaSwapConfigPath ?? ''}|${config?.models.join(',') ?? ''}|${tools}`;
  });
  protected startSwap(): void {
    void this.runtime.start();
  }
  protected stopSwap(): void {
    void this.runtime.stop();
  }
  protected checkSwap(): void {
    void this.runtime.loadDoctor();
  }
  protected repairSwap(): void {
    void this.runtime.repair();
  }
  protected swapState(): string {
    const state = this.managed()?.state ?? 'stopped';
    return this.i18n.t('settings.modelManagement.swap.' + state);
  }

  constructor() {
    const release = this.runtime.observe();
    inject(DestroyRef).onDestroy(release);
    void this.catalog.detect();
    // Engines shows what keeps llama-swap from running: checked when the tab opens and whenever what the doctor looks at changed
    // (the selected config, its models, the installed tools), not on every detection (a Start or Repair detects on its own).
    effect(() => {
      if (this.tab() === 'engines' && this.doctorKey() !== undefined) void this.runtime.loadDoctor();
    });
  }

  protected selectDownload(id: string): void {
    this.selection.set(id);
    this.reviewing.set(true);
    afterNextRender(() => this.review()?.nativeElement.focus(), { injector: this.injector });
  }
  protected backToResults(): void {
    this.reviewing.set(false);
    afterNextRender(
      () =>
        this.results()?.nativeElement.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true }),
      { injector: this.injector },
    );
  }
  protected findModel(): void {
    this.reviewing.set(false);
    this.tab.set('download');
  }
  protected download(): void {
    const model = this.candidate();
    if (
      model &&
      !this.busy() &&
      this.hasConfigTarget() &&
      this.accepted() &&
      this.estimatesCurrent() &&
      model.estimate.fitsDisk
    )
      void this.runtime.download(model.id);
  }
  protected async deleteModel(id: string): Promise<void> {
    await this.runtime.removeModel(id);
    this.removingModel.set('');
  }
  protected async deleteFile(id: string): Promise<void> {
    await this.runtime.removeFile(id);
    this.removingFile.set('');
  }
}
