import { Language } from '@pi-kit/i18n';
import { TestBed } from '@angular/core/testing';
import { appSettingsSetSetting, appSettingsSettings, provideMockApi } from '@pi-kit/api';

import { PANEL_WIDTH, SIDEBAR_WIDTH, ViewPrefs, clampSidebarWidth } from './view-prefs.store';

describe('ViewPrefs', () => {
  const saved: Record<string, unknown> = {};
  const api = {
    all: vi.fn(async () => ({ ...saved })),
    set: vi.fn(async (key: string, value: unknown) => {
      saved[key] = value;
    }),
  };

  beforeEach(() => {
    localStorage.clear();
    for (const key of Object.keys(saved)) delete saved[key];
    api.all.mockClear();
    api.set.mockClear();
    document.documentElement.removeAttribute('style');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [appSettingsSettings, api.all, () => []],
          [appSettingsSetSetting, api.set, (o) => [o.path?.['key'], o.body?.['value']]],
        ]),
      ],
    });
  });

  it('starts from the defaults and from the look copy in localStorage', () => {
    localStorage.setItem('pi-kit.look', JSON.stringify({ proseSize: 17, density: 'compact', codeSize: 99 }));
    localStorage.setItem('pi-kit.showUsage', 'true');
    const prefs = TestBed.inject(ViewPrefs);
    expect(prefs.proseSize()).toBe(17);
    expect(prefs.codeSize()).toBe(13);
    expect(prefs.density()).toBe('compact');
    expect(prefs.showUsage()).toBe(true);
  });

  it('set changes the page, the copy and the backend, and reports the backend', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    expect(await prefs.set('proseSize', 16)).toBe(true);
    expect(prefs.proseSize()).toBe(16);
    expect(JSON.parse(localStorage.getItem('pi-kit.look') ?? '{}')).toMatchObject({ proseSize: 16 });
    expect(api.set).toHaveBeenCalledWith('proseSize', 16);
    api.set.mockRejectedValueOnce(new Error('down'));
    expect(await prefs.set('density', 'compact')).toBe(false);
    expect(prefs.density()).toBe('compact');
  });

  it('keeps localhost certificate exceptions off by default and syncs only the explicit boolean preference to the desktop', async () => {
    const previous = window.piKit;
    const apply = vi.fn(async () => undefined);
    window.piKit = { getBackendUrl: async () => '', getToken: async () => '', setBrowserLocalCertificates: apply };
    try {
      const prefs = TestBed.inject(ViewPrefs);
      TestBed.tick();
      expect(prefs.browserAllowInvalidLocalCertificates()).toBe(false);
      expect(apply).toHaveBeenLastCalledWith(false);
      expect(await prefs.set('browserAllowInvalidLocalCertificates', true)).toBe(true);
      TestBed.tick();
      expect(apply).toHaveBeenLastCalledWith(true);
      expect(JSON.parse(localStorage.getItem('pi-kit.look') ?? '{}').browserAllowInvalidLocalCertificates).toBe(true);
      expect(api.set).toHaveBeenCalledWith('browserAllowInvalidLocalCertificates', true);
      saved['browserAllowInvalidLocalCertificates'] = false;
      await prefs.load();
      TestBed.tick();
      expect(prefs.browserAllowInvalidLocalCertificates()).toBe(false);
      expect(apply).toHaveBeenLastCalledWith(false);
    } finally {
      window.piKit = previous;
    }
  });

  it('writes the look to the page', () => {
    const prefs = TestBed.inject(ViewPrefs);
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--pk-prose-size')).toBe('15px');
    void prefs.set('density', 'compact');
    TestBed.tick();
    expect(document.documentElement.dataset['density']).toBe('compact');
  });

  it('saves screenshot encoding choices and restores them after a reload', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    expect(prefs.screenshotFormat()).toBe('jpeg');
    expect(prefs.screenshotQuality()).toBe(80);
    await prefs.set('screenshotFormat', 'png');
    await prefs.set('screenshotQuality', 35);
    expect(saved).toMatchObject({ screenshotFormat: 'png', screenshotQuality: 35 });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [appSettingsSettings, api.all, () => []],
          [appSettingsSetSetting, api.set, (o) => [o.path?.['key'], o.body?.['value']]],
        ]),
      ],
    });
    const restored = TestBed.inject(ViewPrefs);
    expect(restored.screenshotFormat()).toBe('png');
    expect(restored.screenshotQuality()).toBe(35);
  });

  it('validates saved screenshot preferences, accepting quality zero', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    saved['screenshotFormat'] = 'gif';
    saved['screenshotQuality'] = 101;
    await prefs.load();
    expect(prefs.screenshotFormat()).toBe('jpeg');
    expect(prefs.screenshotQuality()).toBe(80);
    saved['screenshotFormat'] = 'png';
    saved['screenshotQuality'] = 0;
    await prefs.load();
    expect(prefs.screenshotFormat()).toBe('png');
    expect(prefs.screenshotQuality()).toBe(0);
  });

  it('loads valid saved values and ignores invalid ones', async () => {
    saved['codeSize'] = 14;
    saved['proseSize'] = 40;
    saved['shortcuts'] = { 'new-thread': 'mod+alt+n', bad: 5 };
    const prefs = TestBed.inject(ViewPrefs);
    await prefs.load();
    expect(prefs.codeSize()).toBe(14);
    expect(prefs.proseSize()).toBe(15);
    expect(prefs.shortcuts()).toEqual({ 'new-thread': 'mod+alt+n' });
    expect(prefs.combos()['new-thread']).toBe('mod+alt+n');
  });

  it('keeps the inspector switch where the next window load reads it, from a change and from the backend', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    expect(prefs.copilotInspector()).toBe(false);
    await prefs.set('copilotInspector', true);
    expect(localStorage.getItem('pi-kit.copilotInspector')).toBe('true');
    expect(api.set).toHaveBeenCalledWith('copilotInspector', true);
    saved['copilotInspector'] = false;
    await prefs.load();
    expect(localStorage.getItem('pi-kit.copilotInspector')).toBe('false');
  });

  it('keeps the sidebar width within its range', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH.min);
    expect(clampSidebarWidth(9000)).toBe(SIDEBAR_WIDTH.max);
    expect(clampSidebarWidth(301.6)).toBe(302);
    expect(clampSidebarWidth('wide')).toBe(SIDEBAR_WIDTH.default);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default);
  });

  it('collapses the sidebar and sizes its column on the page, and saves both', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--pk-threads')).toBe('280px');
    expect(document.documentElement.dataset['sidebar']).toBeUndefined();
    await prefs.toggleSidebar();
    TestBed.tick();
    expect(document.documentElement.dataset['sidebar']).toBe('collapsed');
    expect(api.set).toHaveBeenCalledWith('sidebarCollapsed', true);
    await prefs.toggleSidebar();
    TestBed.tick();
    expect(document.documentElement.dataset['sidebar']).toBeUndefined();
    await prefs.setSidebarWidth(1000);
    TestBed.tick();
    expect(prefs.sidebarWidth()).toBe(SIDEBAR_WIDTH.max);
    expect(document.documentElement.style.getPropertyValue('--pk-threads')).toBe(`${SIDEBAR_WIDTH.max}px`);
    expect(api.set).toHaveBeenLastCalledWith('sidebarWidth', SIDEBAR_WIDTH.max);
    expect(JSON.parse(localStorage.getItem('pi-kit.look') ?? '{}')).toMatchObject({
      sidebarCollapsed: false,
      sidebarWidth: SIDEBAR_WIDTH.max,
    });
  });

  it('a drag in progress moves the column without saving', () => {
    const prefs = TestBed.inject(ViewPrefs);
    prefs.previewSidebarWidth(320);
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--pk-threads')).toBe('320px');
    expect(api.set).not.toHaveBeenCalled();
  });

  it('previews the tools panel without a write, then persists a bounded width for the next launch', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    await prefs.load();
    prefs.previewPanelWidth(560);
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--pk-panel-width')).toBe('560px');
    expect(api.set).not.toHaveBeenCalled();
    await prefs.setPanelWidth(2000);
    expect(api.set).toHaveBeenCalledExactlyOnceWith('panelWidth', PANEL_WIDTH.max);
    expect(JSON.parse(localStorage.getItem('pi-kit.look') ?? '{}')).toMatchObject({ panelWidth: PANEL_WIDTH.max });
    saved['panelWidth'] = 0;
    await prefs.load();
    expect(prefs.panelWidth()).toBe(PANEL_WIDTH.min);
  });

  it('restores the sidebar from the local copy and from the backend, clamping the width', async () => {
    localStorage.setItem('pi-kit.look', JSON.stringify({ sidebarCollapsed: true, sidebarWidth: 10 }));
    saved['sidebarWidth'] = 360;
    saved['sidebarCollapsed'] = 'yes';
    const prefs = TestBed.inject(ViewPrefs);
    expect(prefs.sidebarCollapsed()).toBe(true);
    expect(prefs.sidebarWidth()).toBe(SIDEBAR_WIDTH.min);
    await prefs.load();
    expect(prefs.sidebarWidth()).toBe(360);
    expect(prefs.sidebarCollapsed()).toBe(true);
  });
  it('persists language in the backend and first-paint cache, then reconciles a saved choice', async () => {
    const prefs = TestBed.inject(ViewPrefs);
    expect(prefs.language()).toBe('en');
    await prefs.load();
    expect(await prefs.set('language', 'de')).toBe(true);
    TestBed.tick();
    await vi.waitFor(() => expect(TestBed.inject(Language).code()).toBe('de'));
    expect(api.set).toHaveBeenCalledWith('language', 'de');
    expect(JSON.parse(localStorage.getItem('pi-kit.look') ?? '{}').language).toBe('de');
    saved['language'] = 'en';
    await prefs.load();
    TestBed.tick();
    await vi.waitFor(() => expect(TestBed.inject(Language).code()).toBe('en'));
    expect(prefs.language()).toBe('en');
    saved['language'] = 'unsupported';
    await prefs.load();
    expect(prefs.language()).toBe('en');
  });
});
