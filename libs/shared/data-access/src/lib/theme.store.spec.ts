import { TestBed } from '@angular/core/testing';
import { appSettingsSetSetting, appSettingsSettings, provideMockApi } from '@pi-kit/api';
import { ThemeStore } from './theme.store';

describe('ThemeStore', () => {
  const api = { all: vi.fn(async (): Promise<Record<string, unknown>> => ({})), set: vi.fn(async () => undefined) };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    api.all.mockClear();
    api.set.mockClear();
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

  it('follows the OS until a theme is chosen, and writes data-theme', () => {
    const theme = TestBed.inject(ThemeStore);
    expect(theme.preference()).toBe('system');
    expect(theme.theme()).toBe('pi-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('pi-dark');
  });

  it('takes the first-paint copy from localStorage', () => {
    localStorage.setItem('pi-kit.theme', 'pi-light');
    const theme = TestBed.inject(ThemeStore);
    expect(theme.theme()).toBe('pi-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('pi-light');
  });

  it('set applies at once, keeps a copy and tells the backend', async () => {
    const theme = TestBed.inject(ThemeStore);
    await theme.set('pi-light');
    expect(theme.theme()).toBe('pi-light');
    expect(localStorage.getItem('pi-kit.theme')).toBe('pi-light');
    expect(api.set).toHaveBeenCalledWith('theme', 'pi-light');
  });

  it('toggle flips between dark and light', async () => {
    const theme = TestBed.inject(ThemeStore);
    theme.toggle();
    await Promise.resolve();
    expect(theme.theme()).toBe('pi-light');
    theme.toggle();
    await Promise.resolve();
    expect(theme.theme()).toBe('pi-dark');
  });

  it.each([
    ['pi-soverius', true],
    ['pi-copilotkit', false],
  ] as const)('restores %s locally and applies its color scheme', (preference, isDark) => {
    localStorage.setItem('pi-kit.theme', preference);
    const theme = TestBed.inject(ThemeStore);
    expect(theme.preference()).toBe(preference);
    expect(theme.theme()).toBe(preference);
    expect(theme.isDark()).toBe(isDark);
    expect(document.documentElement.getAttribute('data-theme')).toBe(preference);
  });

  it.each([
    ['pi-soverius', 'dark'],
    ['pi-copilotkit', 'light'],
  ] as const)('sets native chrome to %s’s %s scheme', async (preference, scheme) => {
    const setThemeSource = vi.fn();
    vi.stubGlobal('piKit', { setThemeSource });
    try {
      const theme = TestBed.inject(ThemeStore);
      await theme.set(preference);
      TestBed.tick();
      expect(setThemeSource).toHaveBeenLastCalledWith(scheme);
      await theme.set('system');
      TestBed.tick();
      expect(setThemeSource).toHaveBeenLastCalledWith('system');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['pi-soverius', 'pi-copilotkit'] as const)(
    'persists and restores %s through the backend',
    async (preference) => {
      const theme = TestBed.inject(ThemeStore);
      await theme.set(preference);
      TestBed.tick();
      expect(localStorage.getItem('pi-kit.theme')).toBe(preference);
      expect(api.set).toHaveBeenCalledWith('theme', preference);
      expect(document.documentElement.getAttribute('data-theme')).toBe(preference);
      await theme.set('pi-dark');
      api.all.mockResolvedValueOnce({ theme: preference });
      await theme.load();
      expect(theme.preference()).toBe(preference);
    },
  );

  it.each([
    ['pi-soverius', 'pi-light'],
    ['pi-copilotkit', 'pi-dark'],
  ] as const)('toggles %s to the opposite standard color scheme', async (preference, opposite) => {
    const theme = TestBed.inject(ThemeStore);
    await theme.set(preference);
    theme.toggle();
    await Promise.resolve();
    expect(theme.theme()).toBe(opposite);
  });

  it('the backend value wins over the copy, and a damaged value is ignored', async () => {
    localStorage.setItem('pi-kit.theme', 'pi-dark');
    api.all.mockResolvedValueOnce({ theme: 'pi-light' });
    const theme = TestBed.inject(ThemeStore);
    await theme.load();
    expect(theme.preference()).toBe('pi-light');
    api.all.mockResolvedValueOnce({ theme: 'blue' });
    await theme.load();
    expect(theme.preference()).toBe('pi-light');
  });
});
