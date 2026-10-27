import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
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

interface UiState {
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
  withMethods((store) => ({
    // ---- panels
    togglePanel(panel: SidePanel): void {
      patchState(store, (s) => ({ panel: s.panel === panel ? null : panel }));
    },
    setPanel(panel: SidePanel | null): void {
      patchState(store, { panel });
    },
    closePanel(): void {
      patchState(store, { panel: null });
    },
    /** Where the panel overlays the page (drawer, sheet) it closes like a menu; beside the transcript it stays. Returns whether it closed. */
    closePanelIfOverlay(): boolean {
      if (store.panel() && window.innerWidth < OVERLAY_BELOW_PX) {
        patchState(store, { panel: null });
        return true;
      }
      return false;
    },
    /** ⌘⇧F: the Files panel opens and focuses its filter. */
    focusFilesFilter(): void {
      patchState(store, (s) => ({ panel: 'files' as SidePanel, filesFilter: s.filesFilter + 1 }));
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
  })),
);
export type UiStore = InstanceType<typeof UiStore>;
