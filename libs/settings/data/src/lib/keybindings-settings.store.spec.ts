import { TestBed } from '@angular/core/testing';
import {
  appSettingsSetSetting,
  appSettingsSettings,
  provideMockApi,
  settingsKeybindings,
  settingsOverview,
  settingsSaveKeybindings,
} from '@pi-kit/api';
import type { KeybindingInfo } from '@pi-kit/protocol';
import { KeybindingsSettingsStore } from './keybindings-settings.store';
import { SettingsStore } from './settings.store';

const binding = (over: Partial<KeybindingInfo> = {}): KeybindingInfo => ({
  id: 'app.interrupt',
  keys: ['escape'],
  description: 'Interrupt',
  default: ['escape'],
  custom: false,
  ...over,
});

describe('KeybindingsSettingsStore', () => {
  const api = {
    keybindings: vi.fn(async () => [binding(), binding({ id: 'app.clear', keys: ['ctrl+l'], default: ['ctrl+l'] })]),
    save: vi.fn(async (overrides: Record<string, string[]>) =>
      Object.entries(overrides).map(([id, keys]) => binding({ id, keys, custom: true })),
    ),
    overview: vi.fn(),
  };
  const dialog = {
    save: vi.fn(<T>(work: () => Promise<T>) => work().catch(() => undefined)),
    setPref: vi.fn(async () => undefined),
    showKeybindings: vi.fn(),
    markReload: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of [...Object.values(api), ...Object.values(dialog)]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        KeybindingsSettingsStore,
        { provide: SettingsStore, useValue: dialog },
        ...provideMockApi([
          [settingsKeybindings, api.keybindings, () => []],
          [settingsSaveKeybindings, api.save, (o) => [o.body?.['overrides']]],
          [settingsOverview, api.overview, () => []],
          [appSettingsSettings, vi.fn(async () => ({})), () => []],
          [appSettingsSetSetting, vi.fn(async () => undefined), () => []],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('regression: reads only pi’s keybindings, never the bundled settings overview', async () => {
    const store = TestBed.inject(KeybindingsSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.piBindings().map((b) => b.id)).toEqual(['app.interrupt', 'app.clear']);
    expect(api.keybindings).toHaveBeenCalledTimes(1);
    expect(api.overview).not.toHaveBeenCalled();
  });

  it('a saved key shows in the section, updates the window’s badge and asks for a session reload', async () => {
    const store = TestBed.inject(KeybindingsSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.setPiKeys('app.clear', ['escape'])).toBe(true);
    expect(api.save).toHaveBeenCalledWith({ 'app.clear': ['escape'] });
    expect(store.piBindings()).toEqual([binding({ id: 'app.clear', keys: ['escape'], custom: true })]);
    expect(dialog.showKeybindings).toHaveBeenCalledWith(store.piBindings());
    expect(dialog.markReload).toHaveBeenCalledTimes(1);
  });

  it('a failed save changes nothing', async () => {
    const store = TestBed.inject(KeybindingsSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    api.save.mockRejectedValueOnce(new Error('read-only'));
    expect(await store.setPiKeys('app.clear', ['escape'])).toBe(false);
    expect(store.piBindings().map((b) => b.keys)).toEqual([['escape'], ['ctrl+l']]);
    expect(dialog.showKeybindings).not.toHaveBeenCalled();
    expect(dialog.markReload).not.toHaveBeenCalled();
  });

  it('exports only the keybindings that differ from the defaults', async () => {
    const store = TestBed.inject(KeybindingsSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    const file = JSON.parse(store.exportKeybindings()) as {
      format: string;
      'pi-kit': Record<string, string>;
      pi: Record<string, string[]>;
    };
    expect(file.format).toBe('pi-kit-keybindings');
    expect(file['pi-kit']).toEqual({});
    expect(file.pi).toEqual({});
  });
});
