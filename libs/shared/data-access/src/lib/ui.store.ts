import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import type { PreviewDescriptor, PreviewRegistration } from '@pi-kit/protocol';
import { readStorage, writeStorage } from './store';
import type { SettingsSectionId } from '@pi-kit/ui';

export type SidePanel = 'tree' | 'files' | 'changes' | 'terminal' | 'artifacts' | 'agents';
/** The section ids of the settings dialog, plus `attendant-activity`, which opens the attendant's section on its Activity tab. */
export type SettingsTab = SettingsSectionId | 'keys' | 'attendant-activity';

/** Below this width the side panel overlays the page (doc/docs/design-system.md, "Layout"). */
export const OVERLAY_BELOW_PX = 1440;
/** Below this width the sidebar is a drawer behind ☰ rather than a column (doc/docs/design-system.md, "Layout"). */
export const DRAWER_BELOW_PX = 1024;
/** Below this width the Files and Terminal panels do not exist (a phone). */
export const PHONE_BELOW_PX = 768;

const PREVIEW_DISMISSALS_KEY = 'pi-kit.preview-dismissals.v1';
const PREVIEW_AUTO_OPEN_KEY = 'pi-kit.preview-auto-open.v1';
const MAX_PREVIEW_DISMISSALS = 200;

export type PreviewAutoOpen = 'ask' | 'always' | 'never';

interface UiState {
  previewThread: string | undefined;
  previewScope: string;
  previews: Record<string, PreviewDescriptor | undefined>;
  previewActivity: Record<string, boolean>;
  previewAutoOpen: PreviewAutoOpen;
  previewPrompt: string | undefined;
  /** A request to open the composer's model picker (`/model` at the search field, `/thinking` at the Effort row) (without an argument); `n` makes repeated requests distinct. */
  chipMenu: { menu: 'model' | 'effort'; n: number } | undefined;
  threadSearch: number;
  /** `/project`: the sidebar opens the menu of the current project when this changes. */
  projectMenu: number;
  composerFocus: number;
  palette: boolean;
  /** The side panel the header's segmented control shows (doc/docs/design-system.md, "Layout"); `null` is closed. */
  panel: SidePanel | null;
  /** ⌘⇧F: the Files panel focuses its filter box when this changes. */
  filesFilter: number;
  /** The settings dialog: which tab it opens on, or `null` when closed; `login` names a provider whose sign-in starts at once; `project` is the folder of the project whose own page opens. */
  settings: { tab: SettingsTab; login?: string; project?: string } | null;
  /** The first-run flow is showing: its full-window cards, or at the last step the strip above the chat page. `OnboardingStore` holds the rest. */
  onboarding: boolean;
  /** Bumped when pi announces a new entry or a leaf change (`pi.tree`); the tree view refetches. */
  treeStale: number;
  /** Text for the composer to take over (the command palette, ↑ to recall); `n` makes equal texts distinct. */
  composerText: { text: string; n: number } | undefined;
  /** Text the composer inserts at the caret (the Files panel's "Add to message"); `n` makes equal texts distinct. */
  composerInsert: { text: string; n: number } | undefined;
}

/**
 * The shell's switches: which side panel is open, the palette, the settings dialog, and the requests between components that
 * do not know each other (the command registry asks for the model popover, the thread search, the composer). A request is a counter or a value that
 * the owner reacts to in an effect; the methods below are the only way to make one.
 */
export const UiStore = signalStore(
  { providedIn: 'root' },
  withState<UiState>({
    previewThread: undefined,
    previewScope: 'local',
    previews: {},
    previewActivity: {},
    previewAutoOpen: 'ask',
    previewPrompt: undefined,
    chipMenu: undefined,
    threadSearch: 0,
    projectMenu: 0,
    composerFocus: 0,
    palette: false,
    panel: null,
    filesFilter: 0,
    settings: null,
    onboarding: false,
    treeStale: 0,
    composerText: undefined,
    composerInsert: undefined,
  }),
  withMethods((store) => {
    let dismissed: string[] = [];
    try {
      const saved: unknown = JSON.parse(readStorage(PREVIEW_DISMISSALS_KEY, 'controller') ?? '[]');
      if (Array.isArray(saved))
        dismissed = saved.filter((v): v is string => typeof v === 'string').slice(-MAX_PREVIEW_DISMISSALS);
    } catch {
      dismissed = [];
    }
    const savedAutoOpen = readStorage(PREVIEW_AUTO_OPEN_KEY, 'controller');
    if (savedAutoOpen === 'always' || savedAutoOpen === 'never') patchState(store, { previewAutoOpen: savedAutoOpen });
    const key = (id: string) => JSON.stringify([store.previewScope(), id]);
    const published = new Set<string>();
    const dismiss = (): void => {
      const id = store.previewThread();
      if (store.panel() !== 'artifacts' || !id) return;
      const value = key(id);
      dismissed = [...dismissed.filter((entry) => entry !== value), value].slice(-MAX_PREVIEW_DISMISSALS);
      writeStorage(PREVIEW_DISMISSALS_KEY, JSON.stringify(dismissed), 'controller');
    };
    const changePanel = (panel: SidePanel | null): void => {
      if (panel !== 'artifacts') dismiss();
      patchState(store, { panel, ...(panel === 'artifacts' ? { previewPrompt: undefined } : {}) });
    };
    return {
      previewFor(threadId: string): PreviewDescriptor | undefined {
        return store.previews()[key(threadId)];
      },
      hasPreview(threadId: string): boolean {
        return !!(store.previews()[key(threadId)] || store.previewActivity()[key(threadId)]);
      },
      selectPreviewThread(threadId: string | undefined, scope = 'local'): void {
        if (store.previewThread() === threadId && store.previewScope() === scope) return;
        if (store.panel() === 'artifacts' || window.innerWidth < OVERLAY_BELOW_PX) changePanel(null);
        patchState(store, { previewThread: threadId, previewScope: scope, previewPrompt: undefined });
      },
      setPreviewAutoOpen(value: PreviewAutoOpen): void {
        writeStorage(PREVIEW_AUTO_OPEN_KEY, value, 'controller');
        const prompted = store.previewPrompt();
        patchState(store, { previewAutoOpen: value, previewPrompt: undefined });
        if (value === 'always' && prompted && prompted === store.previewThread() && store.panel() === null)
          changePanel('artifacts');
      },
      dismissPreviewPrompt(): void {
        patchState(store, { previewPrompt: undefined });
      },
      setPreview(threadId: string, registration: PreviewRegistration, live = false): void {
        const id = key(threadId);
        const first = registration.op === 'set' && !published.has(id);
        if (registration.op === 'set') published.add(id);
        const descriptor =
          registration.op === 'set'
            ? {
                sourceUrl: registration.sourceUrl,
                ...(registration.previewUrl ? { previewUrl: registration.previewUrl } : {}),
                ...(registration.title ? { title: registration.title } : {}),
              }
            : undefined;
        patchState(store, (s) => ({
          previews: { ...s.previews, [id]: descriptor },
          ...(registration.op === 'clear' ? { previewActivity: { ...s.previewActivity, [id]: false } } : {}),
        }));
        if (
          !descriptor ||
          !first ||
          !live ||
          store.previewThread() !== threadId ||
          dismissed.includes(id) ||
          store.panel() !== null
        )
          return;
        if (store.previewAutoOpen() === 'always') changePanel('artifacts');
        else if (store.previewAutoOpen() === 'ask') patchState(store, { previewPrompt: threadId });
      },
      browserActivity(threadId: string): void {
        patchState(store, (s) => ({ previewActivity: { ...s.previewActivity, [key(threadId)]: true } }));
      },
      // ---- panels
      togglePanel(panel: SidePanel): void {
        changePanel(store.panel() === panel ? null : panel);
      },
      setPanel(panel: SidePanel | null): void {
        changePanel(panel);
      },
      closePanel(): void {
        changePanel(null);
      },
      /** Where the panel overlays the page (drawer, sheet) it closes like a menu; beside the transcript it stays. Returns whether it closed. */
      closePanelIfOverlay(): boolean {
        if (store.panel() && window.innerWidth < OVERLAY_BELOW_PX) {
          changePanel(null);
          return true;
        }
        return false;
      },
      /** ⌘⇧F: the Files panel opens and focuses its filter. */
      focusFilesFilter(): void {
        changePanel('files');
        patchState(store, (s) => ({ filesFilter: s.filesFilter + 1 }));
      },

      // ---- palette, settings
      togglePalette(): void {
        patchState(store, (s) => ({ palette: !s.palette }));
      },
      closePalette(): void {
        patchState(store, { palette: false });
      },
      openSettings(tab: SettingsTab = 'general', login?: string, project?: string): void {
        patchState(store, { settings: { tab, ...(login ? { login } : {}), ...(project ? { project } : {}) } });
      },
      closeSettings(): void {
        patchState(store, { settings: null });
      },
      /** `/setup` and the first run: the onboarding flow (a lazy chunk loads the first time this is true). */
      openOnboarding(): void {
        patchState(store, { onboarding: true });
      },
      closeOnboarding(): void {
        patchState(store, { onboarding: false });
      },
      /** The MCP servers and the connectors live in Settings › MCP servers (the sidebar footer, `/mcp` and `/connect` ask for it here). */
      openMcpPanel(): void {
        patchState(store, { settings: { tab: 'mcp' } });
      },

      // ---- requests to the composer and its chips
      openChipMenu(menu: 'model' | 'effort'): void {
        patchState(store, (s) => ({ chipMenu: { menu, n: (s.chipMenu?.n ?? 0) + 1 } }));
      },
      focusThreadSearch(): void {
        patchState(store, (s) => ({ threadSearch: s.threadSearch + 1 }));
      },
      openProjectMenu(): void {
        patchState(store, (s) => ({ projectMenu: s.projectMenu + 1 }));
      },
      focusComposer(): void {
        patchState(store, (s) => ({ composerFocus: s.composerFocus + 1 }));
      },
      /** Asks the composer to insert `text` (an `@path`) at the caret and take the focus. */
      insertIntoComposer(text: string): void {
        patchState(store, (s) => ({ composerInsert: { text, n: (s.composerInsert?.n ?? 0) + 1 } }));
      },
      setComposerText(text: string): void {
        patchState(store, (s) => ({ composerText: { text, n: (s.composerText?.n ?? 0) + 1 } }));
      },
      /** The session tree changed on the backend; the graph fetches it again. */
      markTreeStale(): void {
        patchState(store, (s) => ({ treeStale: s.treeStale + 1 }));
      },
    };
  }),
);
export type UiStore = InstanceType<typeof UiStore>;
