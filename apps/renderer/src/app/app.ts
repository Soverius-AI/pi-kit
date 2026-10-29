import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentsPanel } from '@pi-kit/agents/feature-agents';
import { ArtifactsPanel } from '@pi-kit/artifacts/feature-artifacts';
import { ChatStore, CommandRegistry } from '@pi-kit/chat/api';
import { ChatPage } from '@pi-kit/chat/feature-chat';
import { Palette } from '@pi-kit/chat/feature-composer';
import { DialogHost } from '@pi-kit/chat/feature-composer/dialogs';
import { DialogStore, IS_MAC, PANEL_WIDTH, RedactionStore, ThemeStore, UiStore, ViewPrefs } from '@pi-kit/data-access';
import { PkAnsiText, PkChangesPill, PkDiffTotals, PkIcon, PkLightbox } from '@pi-kit/design-system';
import { FilesPanel } from '@pi-kit/files/feature-files';
import { OnboardingLaunch } from '@pi-kit/onboarding/data';
import { OnboardingStrip, OnboardingWindow } from '@pi-kit/onboarding/feature-onboarding';
import { ChangesStore } from '@pi-kit/review/api';
import { ChangesPanel, ReviewToolbar, ReviewTray, ReviewView } from '@pi-kit/review/feature-review';
import { SessionPanel } from '@pi-kit/session-tree/feature-tree';
import { SettingsDialog } from '@pi-kit/settings/feature-settings';
import { TerminalPanel } from '@pi-kit/terminal/feature-terminal';
import { LearnStore, ThreadsStore, TrustStore, WorktreeStore } from '@pi-kit/threads/api';
import { SkillReviewDialog } from '@pi-kit/threads/feature-learn';
import { OutcomeMenuHost, ThreadSidebar, TrustDialog } from '@pi-kit/threads/feature-sidebar';
import { WorktreeDialog } from '@pi-kit/threads/feature-worktree';
import { formatCombo } from '@pi-kit/ui';
import { ToastHost } from './core/toast-host';
import { PanelSwitcher } from './panel-switcher';
import { ShellStore } from './shell.store';

/**
 * The window: the thread sidebar, the header with the panel switcher, the chat page or the review view, the resizable side panel
 * (tree, files, changes, terminal, agents, artifacts), the status bar, and every dialog and overlay. It renders what `ShellStore`,
 * `UiStore` and `ViewPrefs` say and forwards intent; its own code is the panel resize handle and the theme, onboarding and redaction start-up.
 */
@Component({
  selector: 'pk-root',
  imports: [
    AgentsPanel,
    ArtifactsPanel,
    ChangesPanel,
    ChatPage,
    DialogHost,
    FilesPanel,
    OnboardingStrip,
    OnboardingWindow,
    OutcomeMenuHost,
    Palette,
    PkAnsiText,
    PkChangesPill,
    PkDiffTotals,
    PanelSwitcher,
    ReviewToolbar,
    ReviewTray,
    ReviewView,
    SessionPanel,
    SettingsDialog,
    SkillReviewDialog,
    TerminalPanel,
    ThreadSidebar,
    ToastHost,
    PkLightbox,
    TrustDialog,
    WorktreeDialog,
    TranslocoPipe,
    PkIcon,
  ],
  templateUrl: './app.html',
  host: {
    '(window:pointermove)': 'movePanelResize($event)',
    '(window:pointerup)': 'finishPanelResize($event)',
    '(window:pointercancel)': 'cancelPanelResize()',
    '(window:keydown.escape)': 'cancelPanelResize()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly i18n = inject(Language);
  private readonly isMac = inject(IS_MAC);
  protected readonly shell = inject(ShellStore);
  protected readonly threads = inject(ThreadsStore);
  protected readonly session = inject(ChatStore);
  protected readonly bus = inject(UiStore);
  protected readonly review = inject(ChangesStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly worktrees = inject(WorktreeStore);
  protected readonly learn = inject(LearnStore);
  protected readonly prefs = inject(ViewPrefs);
  protected readonly panelWidth = PANEL_WIDTH;
  protected readonly panelResizing = signal(false);
  private panelGrab?: { x: number; width: number; original: number; pointer: number };
  protected readonly dialogs = inject(DialogStore);
  private readonly trust = inject(TrustStore);
  protected readonly browserSuspended = computed(
    () =>
      !!(
        this.bus.settings() ||
        this.bus.palette() ||
        this.bus.onboarding() ||
        this.dialogs.current() ||
        this.trust.prompt() ||
        this.worktrees.open() ||
        (this.learn.open() && this.learn.editing())
      ),
  );
  /** The header's sidebar switch says what a click does and its shortcut as Settings › Keybindings has it. */
  protected readonly sidebarLabel = computed(() =>
    this.i18n.t('shell.app.sidebar', {
      value1: this.prefs.sidebarCollapsed() ? this.i18n.t('shell.app.show') : this.i18n.t('shell.app.hide'),
      value2: formatCombo(this.prefs.combos()['toggle-sidebar'] ?? '', this.isMac),
    }),
  );
  // The theme applies as soon as the shell exists (data-theme on <html>).
  private readonly theme = inject(ThemeStore);
  // List refreshes replace summaries; only changing the source may resume a learning workspace.
  private readonly learningSource = computed(() => this.threads.selected()?.learning?.sourceThreadId);

  constructor() {
    this.shell.start();
    this.review.showSummary(true);
    effect(() => {
      const source = this.learningSource();
      const editing = this.learn.editing();
      if (source && !editing) untracked(() => this.learn.resume(source));
    });
    // A first run, or a pi with no model to talk to: the setup flow opens. Its code is a lazy chunk that loads only then.
    void inject(OnboardingLaunch).check();
    // The redaction settings (user patterns, folders where the pass is off) for the transcript.
    void inject(RedactionStore).load();
  }

  /** A thread picked in the sidebar: it opens, and on a phone the drawer that held the list closes. */
  protected open(threadId: string, drawer: HTMLInputElement): void {
    this.shell.openThread(threadId);
    drawer.checked = false;
  }

  protected startPanelResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLButtonElement;
    this.panelGrab = {
      x: event.clientX,
      width: window.innerWidth - handle.getBoundingClientRect().right,
      original: this.prefs.panelWidth(),
      pointer: event.pointerId,
    };
    handle.setPointerCapture(event.pointerId);
    handle.focus();
    this.panelResizing.set(true);
  }

  protected movePanelResize(event: PointerEvent): void {
    const grab = this.panelGrab;
    if (!grab || event.pointerId !== grab.pointer) return;
    this.prefs.previewPanelWidth(grab.width + grab.x - event.clientX);
  }

  protected finishPanelResize(event: PointerEvent): void {
    if (!this.panelGrab || event.pointerId !== this.panelGrab.pointer) return;
    this.panelGrab = undefined;
    this.panelResizing.set(false);
    void this.prefs.setPanelWidth(this.prefs.panelWidth());
  }

  protected cancelPanelResize(): void {
    if (!this.panelGrab) return;
    this.prefs.previewPanelWidth(this.panelGrab.original);
    this.panelGrab = undefined;
    this.panelResizing.set(false);
  }

  protected resizePanelKey(event: KeyboardEvent): void {
    const current = this.prefs.panelWidth();
    const next = {
      ArrowLeft: current + PANEL_WIDTH.step,
      ArrowRight: current - PANEL_WIDTH.step,
      Home: PANEL_WIDTH.min,
      End: PANEL_WIDTH.max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    void this.prefs.setPanelWidth(next);
  }
}
