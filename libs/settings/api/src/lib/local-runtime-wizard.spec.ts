import { TranslocoService } from '@pi-kit/i18n';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { modelIdentity } from '@pi-kit/protocol';
import type { LocalCatalog, LocalHardware, LocalRuntimeJob, LocalRuntimeStatus, LocalStorage } from '@pi-kit/protocol';
import { LocalModelCatalogStore, LocalRuntimeStore } from '@pi-kit/settings/data';
import { LocalRuntimeWizard } from './local-runtime-wizard';

const gib = 1024 ** 3;
const facts = (): LocalHardware => ({
  platform: 'darwin',
  arch: 'arm64',
  cpu: 'Fixture machine',
  cores: 8,
  ramBytes: 16 * gib,
  freeRamBytes: 8 * gib,
  diskFreeBytes: 32 * gib,
  acceleration: { kind: 'metal', name: 'Apple Silicon', sharedMemory: true },
  tools: [
    { id: 'llama-server', path: '/tools/llama-server' },
    { id: 'llama-swap', path: '/tools/llama-swap' },
  ],
  llamaSwapConfigPath: '/data/llama-swap.yaml',
  models: ['one', 'two'].map((id) => ({
    id,
    file: `${id}.gguf`,
    path: `/models/${id}.gguf`,
    bytes: gib,
    ...(id === 'one' ? { source: 'https://huggingface.co/Qwen/one', sha256: 'b'.repeat(64) } : {}),
  })),
  servers: [],
  installer: { supported: true, reason: 'Uses Homebrew', sources: [] },
});
const results = (): LocalCatalog => ({
  models: ['alpha', 'beta'].map((id) => ({
    id,
    repository: `Qwen/${id}`,
    revision: 'a'.repeat(40),
    file: `${id}.gguf`,
    bytes: gib,
    sha256: 'b'.repeat(64),
    license: 'apache-2.0',
    source: `https://huggingface.co/Qwen/${id}`,
    downloads: 1,
    estimate: {
      contextTokens: 8192,
      memoryBytes: 4 * gib,
      fitsMemory: true,
      fitsDisk: true,
      explanation: 'Estimated memory',
    },
  })),
  notes: [],
});
const stoppedJob = (): LocalRuntimeJob => ({
  id: 'job',
  kind: 'download',
  state: 'cancelled',
  detail: 'Setup cancelled. You can retry.',
  startedAt: 1,
  logs: [],
  receivedBytes: gib,
  totalBytes: 2 * gib,
  action: { kind: 'download', candidate: results().models[0] },
});

describe('local model library and download recovery', () => {
  const hardware = signal<LocalHardware | undefined>(undefined),
    catalog = signal<LocalCatalog | undefined>(undefined),
    query = signal('');
  const status = signal<LocalRuntimeStatus>({ autostart: false }),
    storage = signal<LocalStorage | undefined>(undefined),
    active = signal(false);
  const operations = {
    detect: vi.fn(async () => undefined),
    readConfig: vi.fn(),
    configFile: vi.fn(async (path: string) => ({ path, text: 'models: {}\n', version: 'a'.repeat(64), mtime: 1 })),
    saveConfigFile: vi.fn(async (path: string, text: string) => ({ path, text, version: 'b'.repeat(64), mtime: 2 })),
    download: vi.fn(),
    start: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
    cancel: vi.fn(),
    register: vi.fn(),
    install: vi.fn(),
    removeModel: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    cleanup: vi.fn(),
    stop: vi.fn(),
    release: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    hardware.set(facts());
    catalog.set(results());
    query.set('');
    active.set(false);
    status.set({ autostart: false, engine: { configPath: '/data/llama-swap.yaml', modelIds: ['one'] } });
    storage.set({ directory: '/data/models', freeBytes: 32 * gib, files: [] });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LocalModelCatalogStore,
          useValue: {
            hardware,
            catalog,
            query,
            lastAddedModelId: signal(undefined),
            detect: operations.detect,
            detecting: signal(false),
            searching: signal(false),
            hardwareError: signal(undefined),
            catalogError: signal(undefined),
            directory: signal(''),
            configPath: signal(''),
            setConfigPath: vi.fn(),
            readConfig: operations.readConfig,
            configFile: operations.configFile,
            saveConfigFile: operations.saveConfigFile,
            setDirectory: vi.fn(),
            setQuery: (value: string) => query.set(value),
            catalogQuery: signal(''),
            catalogContextTokens: signal(8192),
            search: vi.fn(),
          },
        },
        {
          provide: LocalRuntimeStore,
          useValue: {
            ...operations,
            status,
            storage,
            observe: () => operations.release,
            active,
            submitting: signal(false),
            error: signal(undefined),
            canRetry: () => !!status().job?.action,
            storageLoading: signal(false),
            managed: () => status().managed,
            doctor: signal(undefined),
            checking: signal(false),
            loadDoctor: vi.fn(async () => undefined),
            setAutostart: vi.fn(async () => undefined),
            repair: vi.fn(async () => undefined),
          },
        },
      ],
    });
  });
  const open = () => {
    const fixture = TestBed.createComponent(LocalRuntimeWizard);
    fixture.detectChanges();
    return fixture;
  };
  const root = (fixture: ReturnType<typeof open>): HTMLElement => fixture.nativeElement;
  const click = (fixture: ReturnType<typeof open>, text: string) => {
    const button = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    )!;
    expect(button, text).toBeTruthy();
    button.click();
    fixture.detectChanges();
  };
  const tab = (fixture: ReturnType<typeof open>, name: string) => {
    const button = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('[role=tab]')).find((item) =>
      item.textContent?.includes(name),
    )!;
    button.click();
    fixture.detectChanges();
  };

  it('translates the model library, cancelled download recovery and engine controls into German', () => {
    hardware.set({
      ...facts(),
      configs: [{ path: '/data/llama-swap.yaml', models: ['i18n-model'], owned: false, selected: true }],
    });
    status.set({ autostart: false, job: stoppedJob() });
    const fixture = open();
    TestBed.inject(TranslocoService).setActiveLang('de');
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Download: abgebrochen');
    expect(root(fixture).textContent).toContain('Diesen Download wiederholen');
    expect(root(fixture).textContent).toContain('Modell herunterladen');
    expect(root(fixture).querySelector('[placeholder="Deine Modelle filtern"]')).toBeTruthy();
    expect(root(fixture).textContent).toContain('Erweitert: YAML…');
  });
  it('opens a visible model library with sizes, source and registration, without benchmarks or context controls', () => {
    const fixture = open(),
      element = root(fixture);
    expect(element.querySelectorAll('[data-model-id]')).toHaveLength(2);
    expect(element.querySelector('[data-model-id=one]')?.textContent).toContain('In llama-swap');
    expect(element.querySelector('[data-model-id=two]')?.textContent).toContain('Local file');
    expect(element.querySelector('select')).toBeNull();
    expect(element.querySelector('[data-testid=local-context]')).toBeNull();
    expect(element.textContent).not.toMatch(/llama-bench|Measure speed|Context tokens/);
    expect(element.querySelectorAll<HTMLElement>('[role=tabpanel]')[0].hidden).toBe(false);
    const filter = element.querySelector<HTMLInputElement>('[aria-label="Filter your models"]')!;
    filter.value = 'two';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.querySelectorAll('[data-model-id]')).toHaveLength(1);
    fixture.destroy();
    expect(operations.release).toHaveBeenCalledOnce();
  });

  it('shows a downloaded file, its config and live status as one model with a stable identity', () => {
    const config = {
      path: '/data/llama-swap.yaml',
      owned: false,
      selected: true,
      models: ['friendly-alias', 'friendly-alias'],
      modelFiles: { 'friendly-alias': '/models/one.gguf' },
    };
    const initial = { ...facts(), configs: [config], servers: [] };
    hardware.set(initial);
    const fixture = open(),
      element = root(fixture);
    const configured = element.querySelector<HTMLElement>('[data-config-model=friendly-alias]');
    if (!configured) throw new Error('The configured file row is missing.');
    const identity = modelIdentity('llama-swap:' + config.path, 'friendly-alias');
    expect(element.querySelectorAll('[data-model-id=one]')).toHaveLength(1);
    expect(element.querySelectorAll('[data-config-model=friendly-alias]')).toHaveLength(1);
    expect(configured.getAttribute('data-model-uid')).toBe(identity);
    expect(configured.textContent).toContain('1.0 GiB');
    expect(configured.textContent).toContain('Downloaded');
    expect(configured.textContent).toContain('Configure');
    expect(configured.textContent).toContain('Delete');
    expect(element.querySelector('[data-model-id=two]')).not.toBeNull();
    // The same row survives server discovery; its file controls remain available offline too.
    hardware.set({
      ...initial,
      servers: [
        {
          kind: 'llama-swap',
          name: 'Existing server',
          baseUrl: 'http://127.0.0.1:8080/v1',
          models: ['friendly-alias'],
        },
      ],
    });
    fixture.detectChanges();
    expect(element.querySelector('[data-config-model=friendly-alias]')).toBe(configured);
    expect(configured.textContent).toContain('Running');
    expect(element.querySelector('[data-server-model=friendly-alias]')).toBeNull();
    const remove = [...configured.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Delete',
    );
    if (!remove) throw new Error('The file deletion action is missing.');
    remove.click();
    fixture.detectChanges();
    expect(configured.querySelector('[role=alert]')?.textContent).toContain('/models/one.gguf');
  });

  it('lists configured models with server ownership, deduplicates endpoints and keeps file actions separate', () => {
    const external = {
      kind: 'llama-swap' as const,
      name: 'Existing llama-swap',
      baseUrl: 'http://127.0.0.1:8080/v1',
      models: ['deepseek', 'qwen'],
    };
    const owned = {
      kind: 'llama-swap' as const,
      name: 'pi-kit local server',
      baseUrl: 'http://127.0.0.1:4321/v1',
      models: ['manual-entry'],
    };
    hardware.set({
      ...facts(),
      servers: [
        external,
        { ...external, baseUrl: `${external.baseUrl}/` },
        { ...external, baseUrl: 'http://127.0.0.1:9090/v1', models: ['qwen'] },
        owned,
        { ...external, kind: 'ollama', models: ['ollama-model'] },
      ],
    });
    status.set({ ...status(), server: owned });
    const fixture = open(),
      element = root(fixture);
    const rows = element.querySelectorAll('[data-server-model]');
    expect(rows).toHaveLength(4);
    expect(element.querySelectorAll('[data-server-model=qwen]')).toHaveLength(2);
    expect(element.querySelector('[data-server-model=deepseek]')?.textContent).toContain('Server');
    expect(element.querySelector('[data-server-model=deepseek]')?.textContent).toContain(external.baseUrl);
    expect(element.querySelector('[data-server-model=manual-entry]')?.textContent).toContain('Server');
    for (const row of rows) {
      expect(row.querySelector('button')).toBeNull();
      expect(row.textContent).not.toContain('GiB');
    }
    const filter = element.querySelector<HTMLInputElement>('[aria-label="Filter your models"]')!;
    filter.value = '9090';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.querySelectorAll('[data-server-model]')).toHaveLength(1);
    expect(element.querySelectorAll('[data-model-id]')).toHaveLength(0);
    expect(element.textContent).not.toContain('No model matches');
    click(fixture, 'Refresh models');
    expect(operations.detect).toHaveBeenCalledTimes(2);
  });

  it('shows server models even when no GGUF files are discovered and updates after refresh', () => {
    hardware.set({
      ...facts(),
      models: [],
      servers: [
        {
          kind: 'llama-swap',
          name: 'Existing server',
          baseUrl: 'http://127.0.0.1:8080/v1',
          models: ['configured-only'],
        },
      ],
    });
    const fixture = open(),
      element = root(fixture);
    expect(element.querySelector('[data-server-model=configured-only]')).not.toBeNull();
    expect(element.textContent).not.toContain('No models found yet');
    hardware.set({ ...hardware()!, servers: [{ ...hardware()!.servers[0], models: ['replacement'] }] });
    fixture.detectChanges();
    expect(element.querySelector('[data-server-model=configured-only]')).toBeNull();
    expect(element.querySelector('[data-server-model=replacement]')).not.toBeNull();
  });

  it('keeps selected config models visible independently of server discovery and has no private engine controls', () => {
    const config = { path: '/data/llama-swap.yaml', owned: false, selected: true, models: ['manual-entry', 'another'] };
    hardware.set({
      ...facts(),
      configs: [config],
      servers: [
        { kind: 'llama-swap', name: 'Existing server', baseUrl: 'http://127.0.0.1:8080/v1', models: ['manual-entry'] },
      ],
    });
    const fixture = open(),
      element = root(fixture);
    const row = element.querySelector('[data-config-model=manual-entry]')!;
    expect(row.textContent).toContain('Download target');
    expect(row.textContent).toContain('Running');
    expect(row.textContent).toContain('8080');
    expect(element.querySelectorAll('[data-server-model=manual-entry]')).toHaveLength(0);
    expect(element.querySelectorAll('[data-config-model]')).toHaveLength(2);
    expect(row.textContent).toContain(config.path);
    expect(row.querySelector('button')?.textContent?.trim()).toBe('Configure');
    hardware.set({ ...hardware()!, servers: [] });
    fixture.detectChanges();
    expect(element.querySelector('[data-config-model=manual-entry]')).toBe(row);
    expect(row.textContent).toContain('From config');
    expect(element.querySelectorAll('[data-server-model]')).toHaveLength(0);
    expect(element.textContent).not.toMatch(/Start this engine|Stop engine|pi-kit engine|Measure speed/);
    hardware.set({ ...hardware()!, configs: [{ ...config, models: ['edited-on-disk'] }] });
    fixture.detectChanges();
    expect(element.querySelector('[data-config-model=manual-entry]')).toBeNull();
    expect(element.querySelector('[data-config-model=edited-on-disk]')).not.toBeNull();
  });

  it('combines by config and listener while retaining same-named models on a different server', () => {
    hardware.set({
      ...facts(),
      models: [],
      configs: [
        { path: '/config-a.yaml', owned: false, selected: true, baseUrl: 'http://127.0.0.1:8080', models: ['qwen'] },
        { path: '/config-b.yaml', owned: false, baseUrl: 'http://127.0.0.1:9090', models: ['qwen'] },
      ],
      servers: [
        { kind: 'llama-swap', name: 'Server A', baseUrl: 'http://localhost:8080/v1/', models: ['qwen'] },
        { kind: 'llama-swap', name: 'Server A', baseUrl: 'http://127.0.0.1:8080', models: ['qwen'] },
        { kind: 'llama-swap', name: 'Server B', baseUrl: 'http://127.0.0.1:9090/v1', models: ['qwen'] },
        { kind: 'llama-swap', name: 'Unrelated server', baseUrl: 'http://127.0.0.1:7070/v1', models: ['qwen'] },
      ],
    });
    const fixture = open(),
      element = root(fixture);
    const configured = element.querySelectorAll('[data-config-model=qwen]');
    expect(configured).toHaveLength(2);
    for (const row of configured) {
      expect(row.textContent).toContain('Running');
      expect(row.querySelector('button')?.textContent?.trim()).toBe('Configure');
    }
    expect(configured[0].textContent).toContain('/config-a.yaml');
    expect(configured[0].textContent).toContain('8080');
    expect(configured[0].textContent).not.toContain('9090');
    expect(configured[1].textContent).toContain('/config-b.yaml');
    expect(element.querySelectorAll('[data-server-model=qwen]')).toHaveLength(1);
    expect(element.querySelector('[data-server-model=qwen]')?.textContent).toContain('7070');
    const filter = element.querySelector<HTMLInputElement>('[aria-label="Filter your models"]')!;
    filter.value = '8080';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.querySelectorAll('[data-config-model]')).toHaveLength(1);
    expect(element.querySelectorAll('[data-server-model]')).toHaveLength(0);
  });

  it('keeps ambiguous unbound configurations separate instead of attaching the wrong Configure action', () => {
    hardware.set({
      ...facts(),
      models: [],
      configs: [
        { path: '/a.yaml', owned: false, models: ['qwen'] },
        { path: '/b.yaml', owned: false, models: ['qwen'] },
      ],
      servers: [{ kind: 'llama-swap', name: 'Unknown binding', baseUrl: 'http://127.0.0.1:8080/v1', models: ['qwen'] }],
    });
    const fixture = open(),
      element = root(fixture);
    expect(element.querySelectorAll('[data-config-model]')).toHaveLength(2);
    expect(element.querySelectorAll('[data-server-model]')).toHaveLength(1);
    for (const row of element.querySelectorAll('[data-config-model]')) expect(row.textContent).toContain('From config');
  });

  it('lists external YAML models offline, reports config errors and offers a config path in Engines', () => {
    hardware.set({
      ...facts(),
      models: [],
      servers: [],
      configs: [
        { path: '/existing/config.yaml', owned: false, models: ['offline-qwen'] },
        {
          path: '/broken/config.yaml',
          owned: false,
          models: [],
          error: 'The llama-swap config contains invalid YAML.',
        },
      ],
    });
    const fixture = open(),
      element = root(fixture);
    const row = element.querySelector('[data-config-model=offline-qwen]')!;
    expect(row.textContent).toContain('/existing/config.yaml');
    expect(row.textContent).toContain('From config');
    expect(row.textContent).not.toContain('Running');
    expect(element.textContent).not.toContain('No models found yet');
    expect(element.querySelector('[role=alert]')?.textContent).toContain('invalid YAML');
    tab(fixture, 'Engines');
    expect(element.querySelector('input[data-testid=llama-swap-config-path]')).toBeNull();
    expect(element.textContent).toContain('Advanced YAML…');
  });

  it('reuses the file editor for detected YAML with validation and versioned saving', async () => {
    hardware.set({
      ...facts(),
      configs: [
        { path: '/data/llama-swap.yaml', owned: false, selected: true, source: 'Running llama-swap', models: [] },
      ],
    });
    const fixture = open();
    tab(fixture, 'Engines');
    click(fixture, 'Advanced YAML…');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(operations.configFile).toHaveBeenCalledWith('/data/llama-swap.yaml');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('pk-file-editor-dialog textarea')).not.toBeNull();
    });
    const field = root(fixture).querySelector<HTMLTextAreaElement>('pk-file-editor-dialog textarea')!;
    field.value = 'models: [invalid]';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(root(fixture).querySelector<HTMLButtonElement>('[data-testid=editor-save]')!.disabled).toBe(true);
    field.value = '# valid\nmodels: {}\n';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    click(fixture, 'Save YAML');
    await fixture.whenStable();
    expect(operations.saveConfigFile).toHaveBeenCalledWith(
      '/data/llama-swap.yaml',
      '# valid\nmodels: {}\n',
      'a'.repeat(64),
    );
  });

  it('requires file-specific deletion confirmation and offers registration of an existing file', async () => {
    const fixture = open(),
      row = root(fixture).querySelector('[data-model-id=two]')!;
    Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent?.trim() === 'Add to llama-swap')!
      .click();
    expect(operations.register).toHaveBeenCalledWith('two');
    Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent?.trim() === 'Delete')!
      .click();
    fixture.detectChanges();
    expect(row.querySelector('[role=alert]')?.textContent).toContain('/models/two.gguf');
    expect(operations.removeModel).not.toHaveBeenCalled();
    click(fixture, 'Delete file');
    await fixture.whenStable();
    expect(operations.removeModel).toHaveBeenCalledWith('two');
  });

  it('names a restored cancelled download, retries it, and never draws historical bytes as active progress', () => {
    status.set({ ...status(), job: stoppedJob() });
    const fixture = open(),
      card = root(fixture).querySelector('[data-testid=local-job]')!;
    expect(card.textContent).toContain('alpha.gguf');
    expect(card.textContent).toContain('Qwen/alpha');
    expect(card.textContent).toContain('No incomplete download files remain');
    expect(card.querySelector('progress')).toBeNull();
    expect(card.textContent).not.toContain('Cancel download and remove');
    click(fixture, 'Retry this download');
    expect(operations.retry).toHaveBeenCalledOnce();
    click(fixture, 'Dismiss');
    expect(operations.dismiss).toHaveBeenCalledOnce();
  });

  it('explains older jobs that lack a filename instead of offering a broken retry', () => {
    const { action: _action, ...legacy } = stoppedJob();
    status.set({ ...status(), job: legacy });
    const fixture = open(),
      card = root(fixture).querySelector('[data-testid=local-job]')!;
    expect(card.textContent).toContain('This earlier job did not save its file details');
    expect(card.textContent).not.toContain('Retry this download');
    click(fixture, 'Find model again');
    expect(root(fixture).querySelectorAll<HTMLElement>('[role=tabpanel]')[1].hidden).toBe(false);
  });

  it('shows actual leftover bytes and allows cleanup while preserving completed model rows', () => {
    storage.set({
      directory: '/data/models',
      freeBytes: 32 * gib,
      files: [{ id: 'orphan', file: 'model.gguf.partial', bytes: 4 * gib, kind: 'partial' }],
    });
    const fixture = open();
    const clean = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('button')).find((item) =>
      item.textContent?.includes('Remove incomplete downloads'),
    )!;
    expect(clean.textContent).toContain('4.00 GiB');
    clean.click();
    expect(operations.cleanup).toHaveBeenCalledOnce();
    expect(root(fixture).querySelectorAll('[data-model-id]')).toHaveLength(2);
  });

  it('keeps active progress outside tabs and names cancellation as removal of the partial file', () => {
    active.set(true);
    status.set({ ...status(), job: { ...stoppedJob(), state: 'running' } });
    const fixture = open();
    tab(fixture, 'Engines');
    const card = root(fixture).querySelector('[data-testid=local-job]')!;
    expect(card.closest('[role=tabpanel]')).toBeNull();
    expect(card.querySelector('progress')?.value).toBe(gib);
    click(fixture, 'Cancel download and remove partial file');
    expect(operations.cancel).toHaveBeenCalledOnce();
  });

  it('requires consent for the exact chosen file and preserves it when returning to the same file', () => {
    const fixture = open(),
      element = root(fixture);
    tab(fixture, 'Download models');
    const radios = element.querySelectorAll<HTMLInputElement>('input[type=radio]');
    radios[0].click();
    fixture.detectChanges();
    const button = () => element.querySelector<HTMLButtonElement>('[data-testid=local-download]')!;
    const consent = () =>
      element.querySelector<HTMLInputElement>('[data-testid=local-download-review] input[type=checkbox]')!;
    expect(button().disabled).toBe(true);
    consent().click();
    fixture.detectChanges();
    expect(button().disabled).toBe(false);
    click(fixture, '← Back to results');
    radios[0].click();
    fixture.detectChanges();
    expect(consent().checked).toBe(true);
    radios[1].click();
    fixture.detectChanges();
    expect(consent().checked).toBe(false);
    expect(button().disabled).toBe(true);
    consent().click();
    fixture.detectChanges();
    button().click();
    expect(operations.download).toHaveBeenCalledWith('beta');
    query.set('other');
    fixture.detectChanges();
    expect(button().disabled).toBe(true);
  });

  it('requires choosing a config when discovery has no unambiguous download target', () => {
    hardware.set({ ...facts(), llamaSwapConfigPath: '' });
    const fixture = open();
    click(fixture, 'Detect config');
    expect(root(fixture).querySelectorAll<HTMLElement>('[role=tabpanel]')[2].hidden).toBe(false);
    tab(fixture, 'Download models');
    root(fixture).querySelector<HTMLInputElement>('input[type=radio]')!.click();
    fixture.detectChanges();
    root(fixture).querySelector<HTMLInputElement>('[data-testid=local-download-review] input[type=checkbox]')!.click();
    fixture.detectChanges();
    expect(root(fixture).querySelector<HTMLButtonElement>('[data-testid=local-download]')!.disabled).toBe(true);
    expect(operations.download).not.toHaveBeenCalled();
  });

  it('lets the user download above the estimated RAM budget while keeping disk capacity required', () => {
    const choices = results();
    choices.models[0].estimate.fitsMemory = false;
    catalog.set(choices);
    const fixture = open();
    tab(fixture, 'Download models');
    root(fixture).querySelector<HTMLInputElement>('input[type=radio]')!.click();
    fixture.detectChanges();
    root(fixture).querySelector<HTMLInputElement>('[data-testid=local-download-review] input[type=checkbox]')!.click();
    fixture.detectChanges();
    const download = root(fixture).querySelector<HTMLButtonElement>('[data-testid=local-download]')!;
    expect(download.disabled).toBe(false);
    expect(root(fixture).textContent).toContain('You can still download this file');
    download.click();
    expect(operations.download).toHaveBeenCalledWith(choices.models[0].id);
    catalog.set({
      ...choices,
      models: choices.models.map((model) => ({ ...model, estimate: { ...model.estimate, fitsDisk: false } })),
    });
    fixture.detectChanges();
    expect(download.disabled).toBe(true);
  });

  it('offers installation of missing llama-swap and llama.cpp in Engines', () => {
    hardware.set({ ...facts(), tools: [] });
    const fixture = open();
    tab(fixture, 'Engines');
    click(fixture, 'Set up llama.cpp and llama-swap');
    expect(operations.install).toHaveBeenCalledWith(['llama.cpp', 'llama-swap']);
  });
});
