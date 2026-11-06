import { TestBed } from '@angular/core/testing';
import { appSettingsSetSetting, appSettingsSettings, provideMockApi } from '@pi-kit/api';
import type { OmarchyTheme } from '@pi-kit/api';
import { ThemeStore } from './theme.store';

const TOKYO_NIGHT: OmarchyTheme = {
  name: 'tokyo-night',
  mode: 'dark',
  tokens: { '--color-base-100': '#1a1b26', '--color-primary': '#7aa2f7', '--pk-ansi-1': '#f7768e' },
};
const LATTE: OmarchyTheme = {
  name: 'catppuccin-latte',
  mode: 'light',
  tokens: { '--color-base-100': '#eff1f5', '--color-primary': '#1e66f5' },
};

/** The desktop app's bridge on an Omarchy desktop; `switchTo` is the user switching the desktop's theme. */
function omarchyBridge(initial: OmarchyTheme | undefined) {
  let listener: ((theme: OmarchyTheme | undefined) => void) | undefined;
  let current = initial;
  return {
    setThemeSource: vi.fn(),
    omarchyTheme: initial,
    getOmarchyTheme: async () => current,
    onOmarchyTheme: (callback: (theme: OmarchyTheme | undefined) => void) => {
      listener = callback;
      return () => undefined;
    },
    switchTo(theme: OmarchyTheme | undefined): void {
      current = theme;
      listener?.(theme);
    },
  };
}

describe('ThemeStore', () => {
  const api = { all: vi.fn(async (): Promise<Record<string, unknown>> => ({})), set: vi.fn(async () => undefined) };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-scheme');
    document.documentElement.removeAttribute('style');
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

  it('commits an Omarchy transition without waiting for backend persistence and cleans up on destroy', async () => {
    let finish!: () => void;
    let update!: () => void;
    let persisted!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const skipTransition = vi.fn();
    const startViewTransition = vi.fn((callback: () => void) => {
      update = callback;
      return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: startViewTransition });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    try {
      const theme = TestBed.inject(ThemeStore);
      TestBed.tick();
      expect(startViewTransition).not.toHaveBeenCalled();
      api.set.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            persisted = () => resolve(undefined);
          }),
      );
      const saving = theme.set('pi-omarchy');
      TestBed.tick();
      expect(startViewTransition).toHaveBeenCalledOnce();
      expect(document.documentElement.getAttribute('data-theme')).toBe('pi-dark');
      update();
      expect(document.documentElement.getAttribute('data-theme')).toBe('pi-omarchy');
      expect(document.documentElement.getAttribute('data-pk-theme-transition')).toBe('omarchy');
      TestBed.resetTestingModule();
      expect(skipTransition).toHaveBeenCalledOnce();
      expect(document.documentElement.hasAttribute('data-pk-theme-transition')).toBe(false);
      persisted();
      finish();
      await saving;
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
      vi.restoreAllMocks();
    }
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
    ['pi-omarchy', true],
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
    ['pi-omarchy', 'dark'],
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

  it.each(['pi-soverius', 'pi-copilotkit', 'pi-omarchy'] as const)(
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
    ['pi-omarchy', 'pi-light'],
  ] as const)('toggles %s to the opposite standard color scheme', async (preference, opposite) => {
    const theme = TestBed.inject(ThemeStore);
    await theme.set(preference);
    theme.toggle();
    await Promise.resolve();
    expect(theme.theme()).toBe(opposite);
  });

  describe('on an Omarchy desktop', () => {
    const root = document.documentElement;
    const token = (name: string): string => root.style.getPropertyValue(name);
    afterEach(() => vi.unstubAllGlobals());

    it('System is the desktop’s theme: its tokens are on <html> and the window takes its scheme', () => {
      const bridge = omarchyBridge(TOKYO_NIGHT);
      vi.stubGlobal('piKit', bridge);
      const theme = TestBed.inject(ThemeStore);
      TestBed.tick();
      expect(theme.preference()).toBe('system');
      expect(theme.theme()).toBe('pi-desktop');
      expect(theme.isDark()).toBe(true);
      expect(root.getAttribute('data-theme')).toBe('pi-desktop');
      expect(root.getAttribute('data-scheme')).toBe('dark');
      expect(token('--color-primary')).toBe('#7aa2f7');
      expect(bridge.setThemeSource).toHaveBeenLastCalledWith('dark');
    });

    it('follows a switch of the desktop’s theme while it runs', () => {
      const bridge = omarchyBridge(TOKYO_NIGHT);
      vi.stubGlobal('piKit', bridge);
      const theme = TestBed.inject(ThemeStore);
      TestBed.tick();
      const before = theme.palette();
      bridge.switchTo(LATTE);
      TestBed.tick();
      expect(theme.theme()).toBe('pi-desktop');
      expect(theme.isDark()).toBe(false);
      expect(theme.palette()).not.toBe(before);
      expect(root.getAttribute('data-scheme')).toBe('light');
      expect(token('--color-primary')).toBe('#1e66f5');
      // A token only the previous theme had is gone, not left over.
      expect(token('--pk-ansi-1')).toBe('');
      expect(bridge.setThemeSource).toHaveBeenLastCalledWith('light');
    });

    it('a chosen theme replaces the desktop’s, and System brings it back', async () => {
      const bridge = omarchyBridge(TOKYO_NIGHT);
      vi.stubGlobal('piKit', bridge);
      const theme = TestBed.inject(ThemeStore);
      await theme.set('pi-light');
      TestBed.tick();
      expect(root.getAttribute('data-theme')).toBe('pi-light');
      expect(root.getAttribute('data-scheme')).toBe('light');
      expect(token('--color-primary')).toBe('');
      // The saved choice never names Omarchy: a phone paired with this desktop has no such palette.
      expect(api.set).toHaveBeenLastCalledWith('theme', 'pi-light');
      await theme.set('system');
      TestBed.tick();
      expect(root.getAttribute('data-theme')).toBe('pi-desktop');
      expect(token('--color-primary')).toBe('#7aa2f7');
      expect(api.set).toHaveBeenLastCalledWith('theme', 'system');
    });

    it('the Omarchy skin stays its own fixed palette there', async () => {
      vi.stubGlobal('piKit', omarchyBridge(TOKYO_NIGHT));
      const theme = TestBed.inject(ThemeStore);
      await theme.set('pi-omarchy');
      TestBed.tick();
      expect(root.getAttribute('data-theme')).toBe('pi-omarchy');
      expect(root.getAttribute('data-scheme')).toBe('dark');
      expect(token('--color-primary')).toBe('');
    });

    it('clears the tokens the page was first painted with when another theme is the saved choice', () => {
      localStorage.setItem('pi-kit.theme', 'pi-dark');
      for (const [name, color] of Object.entries(TOKYO_NIGHT.tokens)) root.style.setProperty(name, color);
      vi.stubGlobal('piKit', omarchyBridge(TOKYO_NIGHT));
      TestBed.inject(ThemeStore);
      TestBed.tick();
      expect(root.getAttribute('data-theme')).toBe('pi-dark');
      expect(token('--color-primary')).toBe('');
    });

    it('falls back to the OS for a desktop theme without colours', () => {
      const bridge = omarchyBridge(TOKYO_NIGHT);
      vi.stubGlobal('piKit', bridge);
      const theme = TestBed.inject(ThemeStore);
      bridge.switchTo(undefined);
      TestBed.tick();
      expect(theme.theme()).toBe('pi-dark');
      expect(token('--color-primary')).toBe('');
      expect(bridge.setThemeSource).toHaveBeenLastCalledWith('system');
    });
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
