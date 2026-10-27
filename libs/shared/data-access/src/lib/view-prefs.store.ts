import { computed, effect, inject, InjectionToken } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import { Language, isLanguage, type LanguageCode } from '@pi-kit/i18n';
import { resolveShortcuts } from '@pi-kit/ui';
import {
  DEFAULT_SCREENSHOT_FORMAT,
  DEFAULT_SCREENSHOT_QUALITY,
  ScreenshotFormatSchema,
  ScreenshotQualitySchema,
  type BrowserAction,
} from '@pi-kit/protocol';
import { readStorage, withPersistence, writeStorage } from './store';

export type Density = 'comfortable' | 'compact';
export const PROSE_SIZES = [14, 15, 16, 17, 18] as const;
export const CODE_SIZES = [12, 13, 14, 15] as const;
/** The sidebar's width range in px; the default is the `--pk-threads` token (doc/docs/design-system.md, "Layout"). */
export const SIDEBAR_WIDTH = { min: 220, max: 480, default: 280 } as const;
export const PANEL_WIDTH = { min: 320, max: 960, default: 400, step: 16 } as const;

export function clampPanelWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PANEL_WIDTH.default;
  return Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Math.round(value)));
}

/** A width the sidebar can take: rounded to whole px and kept within `SIDEBAR_WIDTH`; anything that is not a number is the default. */
export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_WIDTH.default;
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(value)));
}

/** The line height that goes with a text size, on the 2px steps the design system uses (doc/docs/design-system.md, "Type"). */
const PROSE_LINE: Record<number, number> = { 14: 22, 15: 24, 16: 26, 17: 28, 18: 28 };
const CODE_LINE: Record<number, number> = { 12: 18, 13: 20, 14: 22, 15: 22 };

interface ViewPrefsState {
  language: LanguageCode;
  /** The usage line under every assistant turn instead of only on hover. */
  showUsage: boolean;
  proseSize: number;
  codeSize: number;
  density: Density;
  /** Thinking traces start open. */
  thinkingExpanded: boolean;
  /** The output of tool calls is capped to a few lines. */
  collapseToolOutput: boolean;
  /** Changed pi-kit shortcuts, `{ id: combination }`. */
  shortcuts: Record<string, string>;
  /** The model to use first from each provider, `{ provider: modelId }`. */
  providerDefaults: Record<string, string>;
  /** The sidebar is hidden on a wide window (⌘B); below 1024px it is a drawer either way. */
  sidebarCollapsed: boolean;
  /** The sidebar's width in px, dragged at its right edge (`SIDEBAR_WIDTH`). */
  sidebarWidth: number;
  panelWidth: number;
  /** CopilotKit's web inspector over the window (Settings › Advanced); read when the window loads, so a change applies after a reload. */
  copilotInspector: boolean;
  screenshotFormat: NonNullable<BrowserAction['format']>;
  screenshotQuality: number;
  browserAllowInvalidLocalCertificates: boolean;
}

export type PrefKey = keyof ViewPrefsState;

const DEFAULTS: ViewPrefsState = {
  language: 'en',
  showUsage: false,
  proseSize: 15,
  codeSize: 13,
  density: 'comfortable',
  thinkingExpanded: false,
  collapseToolOutput: false,
  shortcuts: {},
  providerDefaults: {},
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
  panelWidth: PANEL_WIDTH.default,
  copilotInspector: false,
  screenshotFormat: DEFAULT_SCREENSHOT_FORMAT,
  screenshotQuality: DEFAULT_SCREENSHOT_QUALITY,
  browserAllowInvalidLocalCertificates: false,
};

const USAGE_KEY = 'pi-kit.showUsage';
const LOOK_KEY = 'pi-kit.look';
const INSPECTOR_KEY = 'pi-kit.copilotInspector';

/**
 * Whether this window was started with CopilotKit's inspector: `provideCopilotKit` takes it at bootstrap, before the backend has answered, so it comes
 * from the `localStorage` copy and stays fixed until the window reloads.
 */
export function readInspectorPreference(): boolean {
  return readStorage(INSPECTOR_KEY) === 'true';
}

export const COPILOT_INSPECTOR_AT_START = new InjectionToken<boolean>('COPILOT_INSPECTOR_AT_START', {
  providedIn: 'root',
  factory: readInspectorPreference,
});

/** The first paint is right before the backend has answered: a copy of the look-related choices lives in `localStorage` (the database is the source of truth). */
function readLocal(): Partial<ViewPrefsState> {
  const out: Partial<ViewPrefsState> = {
    showUsage: readStorage(USAGE_KEY) === 'true',
    copilotInspector: readStorage(INSPECTOR_KEY) === 'true',
  };
  try {
    const look = JSON.parse(readStorage(LOOK_KEY) ?? '{}') as Partial<ViewPrefsState>;
    if (PROSE_SIZES.includes(look.proseSize as never)) out.proseSize = look.proseSize as number;
    if (CODE_SIZES.includes(look.codeSize as never)) out.codeSize = look.codeSize as number;
    if (isLanguage(look.language)) out.language = look.language;
    if (look.density === 'compact') out.density = 'compact';
    if (look.thinkingExpanded === true) out.thinkingExpanded = true;
    if (look.collapseToolOutput === true) out.collapseToolOutput = true;
    if (look.sidebarCollapsed === true) out.sidebarCollapsed = true;
    if (look.browserAllowInvalidLocalCertificates === true) out.browserAllowInvalidLocalCertificates = true;
    if (look.sidebarWidth !== undefined) out.sidebarWidth = clampSidebarWidth(look.sidebarWidth);
    if (look.panelWidth !== undefined) out.panelWidth = clampPanelWidth(look.panelWidth);
    const format = ScreenshotFormatSchema.safeParse(look.screenshotFormat);
    if (format.success) out.screenshotFormat = format.data;
    const quality = ScreenshotQualitySchema.safeParse(look.screenshotQuality);
    if (quality.success) out.screenshotQuality = quality.data;
  } catch {
    // a damaged copy: the defaults apply
  }
  return out;
}

function writeLocal(state: ViewPrefsState): void {
  writeStorage(USAGE_KEY, String(state.showUsage));
  writeStorage(INSPECTOR_KEY, String(state.copilotInspector));
  const {
    language,
    proseSize,
    codeSize,
    density,
    thinkingExpanded,
    collapseToolOutput,
    sidebarCollapsed,
    sidebarWidth,
    panelWidth,
    screenshotFormat,
    screenshotQuality,
    browserAllowInvalidLocalCertificates,
  } = state;
  writeStorage(
    LOOK_KEY,
    JSON.stringify({
      language,
      proseSize,
      codeSize,
      density,
      thinkingExpanded,
      collapseToolOutput,
      sidebarCollapsed,
      sidebarWidth,
      panelWidth,
      screenshotFormat,
      screenshotQuality,
      browserAllowInvalidLocalCertificates,
    }),
  );
}

const record = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

/** What the backend saved, keeping only values that are valid. */
function parseRemote(saved: Record<string, unknown>): Partial<ViewPrefsState> {
  const patch: Partial<ViewPrefsState> = {};
  if (isLanguage(saved['language'])) patch.language = saved['language'];
  if (typeof saved['showUsage'] === 'boolean') patch.showUsage = saved['showUsage'];
  if (PROSE_SIZES.includes(saved['proseSize'] as never)) patch.proseSize = saved['proseSize'] as number;
  if (CODE_SIZES.includes(saved['codeSize'] as never)) patch.codeSize = saved['codeSize'] as number;
  if (saved['density'] === 'compact' || saved['density'] === 'comfortable') patch.density = saved['density'];
  if (typeof saved['thinkingExpanded'] === 'boolean') patch.thinkingExpanded = saved['thinkingExpanded'];
  if (typeof saved['collapseToolOutput'] === 'boolean') patch.collapseToolOutput = saved['collapseToolOutput'];
  if (saved['shortcuts'] !== undefined) patch.shortcuts = record(saved['shortcuts']);
  if (saved['providerDefaults'] !== undefined) patch.providerDefaults = record(saved['providerDefaults']);
  if (typeof saved['sidebarCollapsed'] === 'boolean') patch.sidebarCollapsed = saved['sidebarCollapsed'];
  if (typeof saved['sidebarWidth'] === 'number') patch.sidebarWidth = clampSidebarWidth(saved['sidebarWidth']);
  if (typeof saved['panelWidth'] === 'number') patch.panelWidth = clampPanelWidth(saved['panelWidth']);
  if (typeof saved['copilotInspector'] === 'boolean') patch.copilotInspector = saved['copilotInspector'];
  if (typeof saved['browserAllowInvalidLocalCertificates'] === 'boolean')
    patch.browserAllowInvalidLocalCertificates = saved['browserAllowInvalidLocalCertificates'];
  const format = ScreenshotFormatSchema.safeParse(saved['screenshotFormat']);
  if (format.success) patch.screenshotFormat = format.data;
  const quality = ScreenshotQualitySchema.safeParse(saved['screenshotQuality']);
  if (quality.success) patch.screenshotQuality = quality.data;
  return patch;
}

/** Writes the look to the page: custom properties the stylesheet reads, and attributes it (and the transcript) key off. */
type Look = Pick<
  ViewPrefsState,
  | 'proseSize'
  | 'codeSize'
  | 'density'
  | 'thinkingExpanded'
  | 'collapseToolOutput'
  | 'sidebarCollapsed'
  | 'sidebarWidth'
  | 'panelWidth'
>;
function apply(state: Look): void {
  const root = document.documentElement;
  root.style.setProperty('--pk-prose-size', `${state.proseSize}px`);
  root.style.setProperty('--pk-prose-line', `${PROSE_LINE[state.proseSize] ?? 24}px`);
  root.style.setProperty('--pk-code-size', `${state.codeSize}px`);
  root.style.setProperty('--pk-code-line', `${CODE_LINE[state.codeSize] ?? 20}px`);
  root.dataset['density'] = state.density;
  if (state.thinkingExpanded) root.dataset['thinking'] = 'open';
  else delete root.dataset['thinking'];
  if (state.collapseToolOutput) root.dataset['toolOutput'] = 'collapsed';
  else delete root.dataset['toolOutput'];
  // layout.css sizes the sidebar column from `--pk-threads` and hides it on a wide window under `data-sidebar="collapsed"`.
  root.style.setProperty('--pk-threads', `${state.sidebarWidth}px`);
  root.style.setProperty('--pk-panel-width', `${state.panelWidth}px`);
  if (state.sidebarCollapsed) root.dataset['sidebar'] = 'collapsed';
  else delete root.dataset['sidebar'];
}

const KEYS: Record<keyof ViewPrefsState, string> = {
  language: 'language',
  showUsage: 'showUsage',
  proseSize: 'proseSize',
  codeSize: 'codeSize',
  density: 'density',
  thinkingExpanded: 'thinkingExpanded',
  collapseToolOutput: 'collapseToolOutput',
  shortcuts: 'shortcuts',
  providerDefaults: 'providerDefaults',
  sidebarCollapsed: 'sidebarCollapsed',
  sidebarWidth: 'sidebarWidth',
  panelWidth: 'panelWidth',
  copilotInspector: 'copilotInspector',
  screenshotFormat: 'screenshotFormat',
  screenshotQuality: 'screenshotQuality',
  browserAllowInvalidLocalCertificates: 'browserAllowInvalidLocalCertificates',
};

/**
 * How the app looks and what it shows, as the user prefers it: the transcript options (usage line, thinking, tool output), text
 * sizes, density, the sidebar's width and whether it is collapsed, pi-kit's changed shortcuts and the per-provider default model. A SignalStore on `withPersistence` kept the way the theme is:
 * the backend's SQLite is the source of truth (`PUT /api/settings/:key`), `localStorage` a copy of the look so the first paint is right. `set` resolves to
 * whether the backend took the value, which is what the settings dialog's "Saved" tick waits for.
 */
export const ViewPrefs = signalStore(
  { providedIn: 'root' },
  withState<ViewPrefsState>(DEFAULTS),
  withPersistence<ViewPrefsState>({ readLocal, writeLocal, remote: { keys: KEYS, parse: parseRemote } }),
  withComputed(({ shortcuts }) => {
    const translate = inject(Language).t;
    return {
      /** The combination in effect for every pi-kit shortcut. */
      combos: computed(() => resolveShortcuts(translate, shortcuts())),
    };
  }),
  withMethods((store) => {
    const methods = {
      /** Reads the saved choices from the backend. */
      load: (): Promise<void> => store.loadPersisted(),
      /** Changes one preference: the page follows at once, the backend is told; false when it could not be saved. */
      set<K extends keyof ViewPrefsState>(key: K, value: ViewPrefsState[K]): Promise<boolean> {
        return store.persist({ [key]: value } as Partial<ViewPrefsState>);
      },
      /** The command palette's and the usage dialog's switch. */
      setShowUsage(value: boolean): Promise<boolean> {
        return methods.set('showUsage', value);
      },
      /** ⌘B and the header's sidebar button: hides the sidebar on a wide window, or brings it back. */
      toggleSidebar(): Promise<boolean> {
        return methods.set('sidebarCollapsed', !store.sidebarCollapsed());
      },
      /** While the edge is dragged: the column follows, nothing is saved yet (`setSidebarWidth` does at the end). */
      previewSidebarWidth(px: number): void {
        patchState(store, { sidebarWidth: clampSidebarWidth(px) });
      },
      /** Keeps a width (the end of a drag, an arrow key on the edge, a double-click back to the default). */
      setSidebarWidth(px: number): Promise<boolean> {
        return methods.set('sidebarWidth', clampSidebarWidth(px));
      },
      previewPanelWidth(px: number): void {
        patchState(store, { panelWidth: clampPanelWidth(px) });
      },
      setPanelWidth(px: number): Promise<boolean> {
        return methods.set('panelWidth', clampPanelWidth(px));
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const language = inject(Language);
      effect(() => {
        void window.piKit
          ?.setBrowserLocalCertificates?.(store.browserAllowInvalidLocalCertificates())
          .catch(() => undefined);
      });
      effect(() => {
        void language.activate(store.language());
      });
      effect(() =>
        apply({
          proseSize: store.proseSize(),
          codeSize: store.codeSize(),
          density: store.density(),
          thinkingExpanded: store.thinkingExpanded(),
          collapseToolOutput: store.collapseToolOutput(),
          sidebarCollapsed: store.sidebarCollapsed(),
          sidebarWidth: store.sidebarWidth(),
          panelWidth: store.panelWidth(),
        }),
      );
      void store.load();
    },
  }),
);
export type ViewPrefs = InstanceType<typeof ViewPrefs>;
