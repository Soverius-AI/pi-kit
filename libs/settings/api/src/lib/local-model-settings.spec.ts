import { TranslocoService } from '@pi-kit/i18n';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LocalModelCatalogStore, LocalRuntimeStore } from '@pi-kit/settings/data';
import type { LocalModelOptions, LocalRuntimeStatus } from '@pi-kit/protocol';
import { LocalModelSettings } from './local-model-settings';

const options = (): LocalModelOptions => ({
  path: '/config.yaml',
  model: 'qwen',
  version: 'a'.repeat(64),
  engine: 'llama.cpp',
  supported: ['name', 'ttl', 'context', 'gpuLayers', 'flashAttention', 'temperature'],
  values: { name: null, ttl: 60, context: 8192, gpuLayers: 'all', flashAttention: 'auto', temperature: 0.7 },
  inherited: { context: 'Uses a config macro.' },
});
describe('model settings form', () => {
  const modelOptions = vi.fn(),
    saveModelOptions = vi.fn();
  const status = signal<LocalRuntimeStatus>({ autostart: false });
  const reloadModel = vi.fn(async (input) => {
    status.set({
      autostart: false,
      job: {
        id: 'reload',
        kind: 'reload',
        state: 'running',
        action: { kind: 'reload', ...input },
        detail: 'Loading qwen…',
        startedAt: 1,
        logs: [],
      },
    });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    status.set({ autostart: false });
    modelOptions.mockResolvedValue(options());
    saveModelOptions.mockImplementation(async (input) => ({
      ...options(),
      version: 'b'.repeat(64),
      values: { ...options().values, ...input.values },
    }));
    TestBed.configureTestingModule({
      providers: [
        { provide: LocalModelCatalogStore, useValue: { modelOptions, saveModelOptions } },
        {
          provide: LocalRuntimeStore,
          useValue: {
            status,
            active: () => ['running', 'cancelling'].includes(status().job?.state ?? ''),
            submitting: () => false,
            error: () => '',
            reloadModel,
          },
        },
      ],
    });
  });
  async function open() {
    const fixture = TestBed.createComponent(LocalModelSettings);
    fixture.componentRef.setInput('path', '/config.yaml');
    fixture.componentRef.setInput('model', 'qwen');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  const input = (fixture: Awaited<ReturnType<typeof open>>, label: string, value: string) => {
    const control = fixture.nativeElement.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    control.value = value;
    control.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const button = (fixture: Awaited<ReturnType<typeof open>>, text: string): HTMLButtonElement =>
    [...fixture.nativeElement.querySelectorAll('button')].find(
      (button) => (button as HTMLButtonElement).textContent?.trim() === text,
    ) as HTMLButtonElement;

  it('validates controls and saves only changed options with the loaded file version', async () => {
    const fixture = await open();
    expect(fixture.nativeElement.textContent).toContain('Uses a config macro.');
    expect(button(fixture, 'Save model settings').disabled).toBe(true);
    input(fixture, 'Context size', '-1');
    expect(button(fixture, 'Save model settings').disabled).toBe(true);
    input(fixture, 'Context size', '16384');
    input(fixture, 'Unload after idle (seconds)', '0');
    button(fixture, 'Save model settings').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(saveModelOptions).toHaveBeenCalledWith({
      path: '/config.yaml',
      model: 'qwen',
      version: 'a'.repeat(64),
      values: { context: 16384, ttl: 0 },
    });
    expect(fixture.nativeElement.textContent).toContain('next model load');
    expect(button(fixture, 'Save model settings').disabled).toBe(true);
  });
  it('switches the open model form to German without losing edits, including validation and discard actions', async () => {
    modelOptions.mockResolvedValue({
      ...options(),
      reload: {
        available: false,
        reason: 'Start the existing llama-swap service for this config to reload a model here.',
      },
    });
    const fixture = await open();
    input(fixture, 'Context size', '16384');
    TestBed.inject(TranslocoService).setActiveLang('de');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="Kontextgröße"]').value).toBe('16384');
    expect(fixture.nativeElement.textContent).toContain('GPU-Schichten');
    expect(fixture.nativeElement.textContent).toContain('Starte den vorhandenen llama-swap-Dienst');
    expect(fixture.nativeElement.textContent).toContain('Generierungsvorgaben');
    expect(button(fixture, 'Modelleinstellungen speichern').disabled).toBe(false);
    input(fixture, 'Kontextgröße', '-1');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Prüfe Kontextgröße.');
    expect(button(fixture, 'Modelleinstellungen speichern').disabled).toBe(true);
    button(fixture, 'Erweitert: YAML…').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Ungespeicherte Änderungen verwerfen und YAML öffnen?');
    expect(button(fixture, 'Änderungen verwerfen')).toBeTruthy();
  });
  it('saves MTP controls with range validation through the same config form', async () => {
    modelOptions.mockResolvedValue({
      ...options(),
      mtp: { status: 'detected', heads: 1 },
      supported: [...options().supported, 'specType', 'specDraftMax', 'specDraftMin', 'specDraftPMin', 'draftModel'],
      values: {
        ...options().values,
        specType: null,
        specDraftMax: 3,
        specDraftMin: 0,
        specDraftPMin: 0,
        draftModel: null,
      },
    });
    const fixture = await open();
    button(fixture, 'MTP').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('GGUF reports MTP heads');
    const mode = fixture.nativeElement.querySelector('[aria-label="Speculative decoding"]') as HTMLSelectElement;
    mode.value = 'draft-mtp';
    mode.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    input(fixture, 'Maximum draft tokens', '6');
    input(fixture, 'Minimum draft tokens', '7');
    expect(button(fixture, 'Save model settings').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Minimum draft tokens must not exceed');
    input(fixture, 'Minimum draft tokens', '2');
    input(fixture, 'Minimum draft probability', '0.1');
    button(fixture, 'Save model settings').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(saveModelOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        values: { specType: 'draft-mtp', specDraftMax: 6, specDraftMin: 2, specDraftPMin: 0.1 },
      }),
    );
  });
  it('shows the saved MTP mode selected as soon as its conditional options render', async () => {
    modelOptions.mockResolvedValue({
      ...options(),
      mtp: { status: 'configured' },
      supported: [...options().supported, 'specType'],
      values: { ...options().values, specType: 'draft-mtp' },
    });
    const fixture = await open();
    button(fixture, 'MTP').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="Speculative decoding"]').value).toBe('draft-mtp');
    expect(fixture.nativeElement.querySelector('[aria-label="Flash Attention"]').value).toBe('auto');
  });
  it('explains unavailable MTP instead of offering an unverified enable control', async () => {
    modelOptions.mockResolvedValue({
      ...options(),
      mtp: { status: 'no-heads', heads: 0 },
      supported: [...options().supported, 'draftModel'],
    });
    const fixture = await open();
    button(fixture, 'MTP').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No MTP heads were found');
    expect(fixture.nativeElement.querySelector('[aria-label="Speculative decoding"]')).toBeNull();
  });
  it('keeps unsaved edits after a conflict and asks before switching to YAML', async () => {
    saveModelOptions.mockRejectedValue(new Error('Config changed since loading.'));
    const fixture = await open(),
      advanced = vi.fn();
    fixture.componentInstance.advanced.subscribe(advanced);
    input(fixture, 'Context size', '16384');
    button(fixture, 'Save model settings').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Config changed since loading.');
    expect(fixture.nativeElement.querySelector('[aria-label="Context size"]').value).toBe('16384');
    button(fixture, 'Advanced YAML…').click();
    fixture.detectChanges();
    expect(advanced).not.toHaveBeenCalled();
    button(fixture, 'Discard changes').click();
    expect(advanced).toHaveBeenCalledOnce();
  });
  it('exposes only supported controls for a custom engine', async () => {
    modelOptions.mockResolvedValue({
      ...options(),
      engine: 'custom',
      supported: ['name', 'ttl'],
      values: { name: null, ttl: 120 },
    });
    const fixture = await open();
    expect(fixture.nativeElement.querySelector('[aria-label="Context size"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('custom launcher');
    expect(fixture.nativeElement.textContent).not.toContain('Generation defaults');
  });
  it('saves before reload and reports success only when the observed job confirms readiness', async () => {
    modelOptions.mockResolvedValue({ ...options(), reload: { available: true, baseUrl: 'http://127.0.0.1:8080' } });
    const fixture = await open();
    input(fixture, 'Context size', '32768');
    button(fixture, 'Save and reload model').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(reloadModel).toHaveBeenCalledWith({ path: '/config.yaml', model: 'qwen', version: 'b'.repeat(64) });
    expect(fixture.nativeElement.textContent).toContain('Loading qwen…');
    expect(fixture.nativeElement.textContent).not.toContain('Model reloaded and ready.');
    status.update((current) => ({
      ...current,
      job: current.job ? { ...current.job, state: 'complete', detail: 'qwen is ready' } : undefined,
    }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Model reloaded and ready.');
  });
});
