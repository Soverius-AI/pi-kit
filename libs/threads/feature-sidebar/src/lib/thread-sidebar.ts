import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  ApiClient,
  sessionOpenInEditor,
  type TrayThread,
  unwrap,
  worktreeBranch,
  worktreeRemove,
  worktreeState,
} from '@pi-kit/api';
import {
  CONTEXT_POLICY,
  ClockStore,
  DRAWER_BELOW_PX,
  DialogStore,
  HealthStore,
  IS_MAC,
  SIDEBAR_WIDTH,
  ThemeStore,
  ToastStore,
  UiStore,
  ViewPrefs,
} from '@pi-kit/data-access';
import { PkIcon, PkOutcomeBadge, PkRunRing, PkTip, PkViewportMenu } from '@pi-kit/design-system';
import type { ThreadSuggestion, ThreadSummary } from '@pi-kit/protocol';
import { ConnectorsStore } from '@pi-kit/settings/api';
import {
  type Project,
  ChangedCountStore,
  LearnStore,
  NewThreadStore,
  OutcomeMenuStore,
  ThreadShell,
  ThreadsStore,
  WorktreeReview,
  WorktreeStore,
} from '@pi-kit/threads/data';
import { FocusSelect } from '@pi-kit/threads/ui';
import {
  type AnswerChip,
  type CollapsedTag,
  type NeedsItem,
  type StateKind,
  type StatusLine,
  type ThreadGroup,
  SECTION_HEADERS_ABOVE,
  collapsedTags,
  contextLevel,
  gaugeBesideStatus,
  groupThreads,
  hasCliMark,
  learnChipText,
  learnMenuEntry,
  matches,
  needsYou,
  outcomeTitle,
  shortTime,
  statusLine,
  summaryLine,
  threadLabel,
  tileHue,
  tileLetter,
} from '@pi-kit/threads/util';
import { formatCombo } from '@pi-kit/ui';
import { UpdateStore } from '@pi-kit/update/api';

/** A project as the sidebar draws it: its threads after the search, whether its group is open, and the sections when it has many. */
interface ProjectView {
  project: Project;
  threads: ThreadSummary[];
  expanded: boolean;
  sections: ThreadGroup[];
  /** A badge for the collapsed group that the running and waiting counts do not already show. */
  collapsedBadge: StateKind | undefined;
  /** The mini tags of the folded band: "2 running", "1 waiting". */
  tags: CollapsedTag[];
}

/** One tile of the rail (a collapsed sidebar): a project, with a dot while a thread of it runs or waits. */
interface RailTile {
  cwd: string;
  name: string;
  hue: ReturnType<typeof tileHue>;
  letter: string;
  dot: 'run' | 'wait' | undefined;
  current: boolean;
  tip: string;
}

/** What the rail or a native notification asks the full sidebar to reveal. */
type ScrollTarget = { needs: true } | { project: string } | { thread: string };

/**
 * The single left column: the search and the "+" on top, a strip of quick actions for the
 * current project, the "Needs you" strip with answer chips, then every known folder as a project band (sticky, with its tile, branch and counts) over its threads as
 * filled rows of three lines (title, summary, status), "Add a project…" at the bottom and the backend status in the footer. Collapsed on a wide window it is a 48px
 * rail of project tiles. A thread's state (running, waiting with the question, context, error, unread, cli) is computed in the backend and arrives pushed. The
 * component renders `ThreadsStore` and forwards intent; it only emits `opened`, the shell decides how the chat switches.
 */
@Component({
  selector: 'pk-thread-sidebar',
  imports: [FocusSelect, NgTemplateOutlet, PkOutcomeBadge, PkRunRing, PkTip, PkViewportMenu, TranslocoPipe, PkIcon],
  templateUrl: './thread-sidebar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `.pk-threads` is the grid area and flex column from layout.css.
  host: { class: 'pk-threads' },
})
export class ThreadSidebar {
  protected readonly i18n = inject(Language);
  private readonly isMac = inject(IS_MAC);
  private readonly contextPolicy = inject(CONTEXT_POLICY);
  protected readonly store = inject(ThreadsStore);
  private readonly dialogs = inject(DialogStore);
  private readonly health = inject(HealthStore);
  private readonly shell = inject(ThreadShell);
  private readonly learn = inject(LearnStore);
  private readonly clock = inject(ClockStore);
  protected readonly bus = inject(UiStore);
  /** The footer's theme switch (dark ↔ light; "System" stays a choice in Settings › Appearance). */
  protected readonly theme: ThemeStore = inject(ThemeStore);
  /** The sidebar's width, dragged at its right edge (collapsing it is the header's switch). */
  protected readonly prefs: ViewPrefs = inject(ViewPrefs);
  protected readonly widthRange = SIDEBAR_WIDTH;
  protected readonly mcp = inject(ConnectorsStore);
  protected readonly updates = inject(UpdateStore);
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);
  private readonly worktrees = inject(WorktreeStore);
  private readonly newThread = inject(NewThreadStore);
  private readonly outcomeMenu = inject(OutcomeMenuStore);
  private readonly review = inject(WorktreeReview);
  private readonly toasts = inject(ToastStore);
  private readonly destroyRef = inject(DestroyRef);
  /** The count on the "Working tree changes" button. */
  protected readonly changed = inject(ChangedCountStore);
  /** The desktop app can open a folder in an editor; a browser cannot. */
  protected readonly desktop = typeof window !== 'undefined' && !!window.piKit;

  /** Emits the id of the thread the user chose or created. */
  readonly opened = output<string>();

  protected readonly query = signal('');
  protected readonly renaming = signal<string | undefined>(undefined);
  protected readonly deleting = signal<ThreadSummary | undefined>(undefined);
  /** A thread being archived that has a worktree: the dialog asks what happens to it. */
  protected readonly archiving = signal<ThreadSummary | undefined>(undefined);
  /** What the archive or delete dialog knows about the thread's worktree: how many uncommitted changes it holds (unknown while it is read) and the choice. */
  protected readonly leaving = signal<{ dirty: number | undefined; choice: 'keep' | 'remove' }>({
    dirty: 0,
    choice: 'keep',
  });
  /** The project being dragged, and where a drop would put it. */
  protected readonly dragging = signal<string | undefined>(undefined);
  protected readonly over = signal<{ cwd: string; where: 'above' | 'below' } | undefined>(undefined);
  /** The threads whose "Needs you" answer is on its way: their chips are off until the state arrives. */
  protected readonly answering = signal<ReadonlySet<string>>(new Set());
  /** What the rail or a notification asked the full sidebar to scroll to; done once the sidebar is open again. */
  private pendingScroll: ScrollTarget | undefined;
  /** One native notification per waiting period. It is closed when the question is resolved or replaced. */
  private readonly attentionNotifications = new Map<string, { key: string; notification: Notification | undefined }>();
  /** Compact density: a row is the title and the time, the state a small glyph. */
  protected readonly compact = computed(() => this.prefs.density() === 'compact');

  /** Relative times change slowly; this ticks every half minute. */
  private readonly minute = computed(() => Math.floor(this.clock.now() / 30_000));

  constructor() {
    const stopTrayListener = window.piKit?.onTrayOpenThread?.((threadId) =>
      untracked(() => this.openFromSystem(threadId)),
    );
    this.destroyRef.onDestroy(() => {
      stopTrayListener?.();
      for (const entry of this.attentionNotifications.values()) entry.notification?.close();
      this.attentionNotifications.clear();
    });
    // Keep the native tray useful while the window is minimized: waiting questions first, then active runs.
    effect(() => {
      const threads: TrayThread[] = this.store.visibleProjects().flatMap((project) =>
        project.threads.flatMap((thread): TrayThread[] => {
          if (thread.archived || (thread.state.activity !== 'running' && thread.state.activity !== 'waiting'))
            return [];
          return [
            {
              id: thread.id,
              title: threadLabel(this.i18n.t, thread),
              project: project.workspace.name,
              state: thread.state.activity,
            },
          ];
        }),
      );
      const waiting = threads.filter((thread) => thread.state === 'waiting').length;
      const running = threads.length - waiting;
      const labels = {
        needsYou: this.i18n.t('desktop.tray.needsYou'),
        runningThreads: this.i18n.t('desktop.tray.runningThreads'),
        noActiveThreads: this.i18n.t('desktop.tray.noActiveThreads'),
        showApp: this.i18n.t('desktop.tray.showApp'),
        quit: this.i18n.t('desktop.tray.quit'),
        tooltip: threads.length
          ? this.i18n.t('desktop.tray.tooltip', { running, waiting })
          : this.i18n.t('desktop.tray.emptyTooltip'),
        waitingMore: this.i18n.t('desktop.tray.more', { count: Math.max(0, waiting - 12) }),
        runningMore: this.i18n.t('desktop.tray.more', { count: Math.max(0, running - 12) }),
      };
      untracked(() => void window.piKit?.setTrayThreads?.(threads, labels).catch(() => undefined));
    });
    // A waiting question is not confined to the sidebar: the desktop also raises a clickable system notification.
    effect(() => {
      const items = needsYou(this.i18n.t, this.store.visibleProjects()).items;
      untracked(() => this.syncAttentionNotifications(items));
    });
    // `/resume`, the palette and the search shortcut ask for the search field; on the rail the sidebar opens first.
    effect(() => {
      if (this.bus.threadSearch() === 0) return;
      untracked(() => {
        const drawer = document.getElementById('t-threads') as HTMLInputElement | null;
        if (drawer) drawer.checked = true;
        const onRail = this.prefs.sidebarCollapsed() && window.innerWidth >= DRAWER_BELOW_PX;
        if (onRail) void this.prefs.toggleSidebar();
        setTimeout(() => this.search().nativeElement.focus(), onRail ? 80 : 0);
      });
    });
    // The rail opened the sidebar, or a notification selected a thread: scroll once the column and target row are ready.
    effect(() => {
      const collapsed = this.prefs.sidebarCollapsed();
      const selected = this.store.selectedId();
      if (collapsed) return;
      untracked(() => {
        const target = this.pendingScroll;
        if (!target || ('thread' in target && target.thread !== selected)) return;
        this.pendingScroll = undefined;
        // A folded project and a selection behind a trust prompt draw later; retry while the column settles.
        for (const ms of [80, 250, 500]) setTimeout(() => this.scrollTo(target, 'thread' in target), ms);
      });
    });
    // `/project` opens the menu of the current project.
    effect(() => {
      if (this.bus.projectMenu() === 0) return;
      untracked(() =>
        queueMicrotask(() => {
          const drawer = document.getElementById('t-threads') as HTMLInputElement | null;
          if (drawer) drawer.checked = true;
          const cwd = this.store.cwd();
          const menu = [
            ...this.host.nativeElement.querySelectorAll<HTMLDetailsElement>('details[data-project-menu]'),
          ].find((d) => d.dataset['projectMenu'] === cwd);
          menu?.setAttribute('open', '');
          menu?.querySelector<HTMLElement>('button')?.focus();
        }),
      );
    });
  }

  protected readonly views = computed<ProjectView[]>(() => {
    const query = this.query().trim();
    const out: ProjectView[] = [];
    for (const project of this.store.visibleProjects()) {
      const threads = query ? project.threads.filter((t) => matches(t, query)) : project.threads;
      // A search shows every project that has a match, open; without one, the project's own fold decides.
      if (query && threads.length === 0) continue;
      const expanded = query ? true : !project.workspace.collapsed;
      const strongest = project.strongest;
      out.push({
        project,
        threads,
        expanded,
        sections:
          threads.length > SECTION_HEADERS_ABOVE ? groupThreads(this.i18n.t, threads) : [{ label: '', threads }],
        // Running and waiting are the counts; everything else a project can show is a glyph (or the gauge) when it is folded.
        collapsedBadge:
          !expanded && strongest && strongest !== 'running' && strongest !== 'waiting' ? strongest : undefined,
        tags: collapsedTags(this.i18n.t, project.counts),
      });
    }
    return out;
  });

  /** The threads waiting for the person across the projects the sidebar lists. */
  protected readonly needs = computed(() => needsYou(this.i18n.t, this.store.visibleProjects()));

  /** The project the quick actions work on: the open thread's, else the one picked last, else the first. */
  protected readonly current = computed<Project | undefined>(() => {
    const visible = this.store.visibleProjects();
    const cwd = this.store.cwd();
    return visible.find((p) => p.workspace.cwd === cwd) ?? visible[0];
  });

  protected readonly rail = computed<RailTile[]>(() => {
    const cwd = this.current()?.workspace.cwd;
    return this.store.visibleProjects().map((p) => {
      const { running, waiting } = p.counts;
      const bits = [
        running > 0 ? this.i18n.t('threads.threadSidebar.runningCount', { value1: running }) : '',
        waiting > 0 ? this.i18n.t('threads.threadSidebar.waitingForYou', { value1: waiting }) : '',
      ].filter(Boolean);
      return {
        cwd: p.workspace.cwd,
        name: p.workspace.name,
        hue: tileHue(p.workspace.name),
        letter: tileLetter(p.workspace.name),
        dot: waiting > 0 ? 'wait' : running > 0 ? 'run' : undefined,
        current: p.workspace.cwd === cwd,
        tip: bits.length > 0 ? `${p.workspace.name} · ${bits.join(', ')}` : p.workspace.name,
      };
    });
  });

  protected readonly backendLabel = computed(() => {
    if (this.store.error()) return this.store.error();
    switch (this.health.state()) {
      case 'ok':
        return this.i18n.t('threads.threadSidebar.backendConnected');
      case 'error':
        return this.i18n.t('threads.threadSidebar.backendUnreachable');
      default:
        return this.i18n.t('threads.threadSidebar.connectingToBackend');
    }
  });
  protected readonly dotClass = computed(() => {
    if (this.store.error()) return 'bg-error';
    switch (this.health.state()) {
      case 'ok':
        return 'bg-success';
      case 'error':
        return 'bg-error';
      default:
        return 'bg-warning';
    }
  });

  protected readonly label = threadLabel.bind(undefined, this.i18n.t);
  protected readonly level = (pct: number | null) => contextLevel(pct, this.contextPolicy);
  protected readonly hue = tileHue;
  protected readonly letter = tileLetter;
  protected readonly summaryOf = summaryLine.bind(undefined, this.i18n.t);

  /** A shortcut as the keybindings have it, for a tooltip: "⌘⇧N". */
  protected key(id: string): string {
    return formatCombo(this.prefs.combos()[id] ?? '', this.isMac);
  }

  /** The short relative time of a row ("12m", "Tue"). */
  protected when(thread: ThreadSummary): string {
    this.minute();
    return shortTime(this.i18n.t, thread.updatedAt);
  }

  /** A row's state in words and colour (the status line). */
  protected statusOf(thread: ThreadSummary): StatusLine {
    return statusLine(this.i18n.t, thread, { looking: thread.id === this.store.selectedId() }, this.contextPolicy);
  }

  /** A context ring beside a state that is not the context itself, from 70 %. */
  protected gaugeBeside(thread: ThreadSummary, status: StatusLine): 'warn' | 'err' | undefined {
    // A running row carries context in its animated ring at every percentage, rather than adding a second gauge at 70%.
    if (status.kind === 'running') return undefined;
    return gaugeBesideStatus(thread, status, this.contextPolicy);
  }

  /** The thread changed in the pi command line since it was looked at. */
  protected cliMark(thread: ThreadSummary): boolean {
    return hasCliMark(thread, { looking: thread.id === this.store.selectedId() });
  }

  /** The outcome badge's tooltip: "Merged into main as a1b2c3d, 2 h ago". */
  protected outcomeLabel(thread: ThreadSummary): string {
    this.minute();
    return thread.state.outcome
      ? outcomeTitle(this.i18n.t, thread.state.outcome, thread.worktree?.base, this.clock.now())
      : '';
  }

  /** The width the edge was grabbed at and where; `undefined` when no drag is in progress. */
  private grab: { x: number; width: number } | undefined;
  protected readonly resizing = signal(false);

  /** The edge is grabbed: the pointer is kept until it is let go, wherever it moves. */
  protected startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.grab = { x: event.clientX, width: this.prefs.sidebarWidth() };
    this.resizing.set(true);
    document.documentElement.dataset['sidebarDrag'] = '';
  }

  /** The column follows the pointer; nothing is saved until the drag ends. */
  protected moveResize(event: PointerEvent): void {
    if (this.grab) this.prefs.previewSidebarWidth(this.grab.width + event.clientX - this.grab.x);
  }

  protected endResize(event: PointerEvent): void {
    if (!this.grab) return;
    this.grab = undefined;
    this.resizing.set(false);
    delete document.documentElement.dataset['sidebarDrag'];
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    void this.prefs.setSidebarWidth(this.prefs.sidebarWidth());
  }

  /** The separator's keys: ←/→ by 16px, Home/End to the narrowest/widest. */
  protected resizeByKey(event: KeyboardEvent): void {
    const width = this.prefs.sidebarWidth();
    const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: SIDEBAR_WIDTH.min, End: SIDEBAR_WIDTH.max }[
      event.key
    ];
    if (next === undefined) return;
    event.preventDefault();
    void this.prefs.setSidebarWidth(next);
  }

  /** The badge was pressed: its menu opens under it (the host in the shell draws it), and the row does not open the thread. */
  protected openOutcomeMenu(event: MouseEvent, thread: ThreadSummary): void {
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.outcomeMenu.openFor(thread.id, box.left, box.bottom + 4);
  }

  protected answerOf(thread: ThreadSummary): ThreadSuggestion | undefined {
    return thread.state.suggestions.find((s) => s.kind === 'answer');
  }

  protected labelOf(thread: ThreadSummary): ThreadSuggestion | undefined {
    return thread.state.suggestions.find((s) => s.kind === 'label');
  }

  /** The attendant's drafted skill, offered to read; the same place as its labels and answers. */
  protected learnOf(thread: ThreadSummary): ThreadSuggestion | undefined {
    return thread.state.suggestions.find((s) => s.kind === 'learn');
  }

  protected readonly learnChipText = learnChipText.bind(undefined, this.i18n.t);

  /** The thread menu's entry about learning: ask for a draft, read the pending one, reopen the discarded one, or say it was learned. */
  protected learnEntry(thread: ThreadSummary) {
    return learnMenuEntry(this.i18n.t, thread.state.draft, thread.messageCount);
  }

  protected learnFrom(event: Event, thread: ThreadSummary): void {
    closeMenu(event);
    this.opened.emit(thread.id);
    void this.learn.learnFrom(thread);
  }

  protected firstWaiting(view: ProjectView): ThreadSummary | undefined {
    return view.project.threads.find((t) => t.state.activity === 'waiting');
  }

  protected glyphLabel(kind: StateKind): string {
    return {
      waiting: this.i18n.t('threads.threadSidebar.waitingForYourAnswer'),
      error: this.i18n.t('threads.threadSidebar.theLastRunFailed'),
      running: this.i18n.t('threads.threadSidebar.running73989'),
      aborted: this.i18n.t('threads.threadSidebar.theLastRunWasAborted'),
      unread: this.i18n.t('threads.threadSidebar.finishedSinceYouLastLooked'),
      cli: this.i18n.t('threads.threadSidebar.changedInThePiCommandLineSince'),
      context: '',
      'context-high': '',
    }[kind];
  }

  /** Opens the row's thread, unless the click was on one of its buttons, its menu or its rename field. */
  protected rowClick(event: Event, thread: ThreadSummary): void {
    if ((event.target as HTMLElement).closest('details, input, button')) return;
    if (this.renaming() !== thread.id) this.opened.emit(thread.id);
  }

  // ---- Needs you

  /** The title of an item opens the thread. */
  protected openThread(event: Event, thread: ThreadSummary): void {
    event.stopPropagation();
    this.opened.emit(thread.id);
  }

  /** Mirrors each new waiting period into a desktop notification. Clicking one opens the question and reveals its row. */
  private syncAttentionNotifications(items: NeedsItem[]): void {
    const waiting = new Set(items.map((item) => item.thread.id));
    for (const [id, entry] of this.attentionNotifications) {
      if (waiting.has(id)) continue;
      entry.notification?.close();
      this.attentionNotifications.delete(id);
    }

    for (const item of items) {
      const key = `${item.thread.state.dialog?.id ?? ''}:${item.question}`;
      const previous = this.attentionNotifications.get(item.thread.id);
      if (previous?.key === key) continue;
      previous?.notification?.close();

      let notification: Notification | undefined;
      if (typeof window !== 'undefined' && window.piKit && typeof Notification !== 'undefined') {
        try {
          notification = new Notification(
            this.i18n.t('threads.threadSidebar.needsYouNotification', { title: threadLabel(this.i18n.t, item.thread) }),
            {
              body: `${item.question}\n${item.project.name}`,
              tag: `pi-kit-needs-${item.thread.id}`,
            },
          );
          notification.onclick = () => {
            notification?.close();
            window.focus();
            this.openFromSystem(item.thread.id);
          };
        } catch {
          // A host can deny native notifications; Needs you in the sidebar remains the fallback.
        }
      }
      this.attentionNotifications.set(item.thread.id, { key, notification });
    }
  }

  /** A native notification or tray item opens its thread; waiting ones also jump to the approval block. */
  private openFromSystem(threadId: string): void {
    const thread = this.store
      .visibleProjects()
      .flatMap((project) => project.threads)
      .find((candidate) => candidate.id === threadId);
    if (!thread) return;
    if (this.store.selectedId() !== threadId) this.revealThread(threadId);
    if (thread.state.activity === 'waiting') this.shell.openWaiting(threadId);
    this.opened.emit(threadId);
  }

  /** Makes a notification jump visible in the left column, even when its project was folded or the sidebar was a rail. */
  private revealThread(threadId: string): void {
    this.query.set('');
    const target: ScrollTarget = { thread: threadId };
    const onRail = this.prefs.sidebarCollapsed() && window.innerWidth >= DRAWER_BELOW_PX;
    this.pendingScroll = target;
    if (onRail) void this.prefs.toggleSidebar();
    for (const ms of [0, 80, 250, 500]) setTimeout(() => this.scrollTo(target, true), ms);
  }

  /** A chip: it answers the dialog without opening the thread (the attendant's suggestion is marked accepted), or, for "Open", opens the thread at its question. */
  protected async answer(event: Event, item: NeedsItem, chip: AnswerChip): Promise<void> {
    event.stopPropagation();
    if (chip.action.type === 'open') return this.openWaiting(event, item.thread);
    const suggestion = chip.suggested ? item.thread.state.suggestions.find((s) => s.kind === 'answer') : undefined;
    this.answering.update((ids) => new Set(ids).add(item.thread.id));
    try {
      await this.shell.answerWaiting(item.thread, chip.action.dialogId, chip.action.payload, suggestion);
    } finally {
      this.answering.update((ids) => {
        const next = new Set(ids);
        next.delete(item.thread.id);
        return next;
      });
    }
  }

  // ---- the rail

  /** A tile or the count of the rail: the sidebar opens, scrolled to the project or to the strip. */
  protected expandTo(target: ScrollTarget): void {
    this.pendingScroll = target;
    if ('project' in target) void this.store.setCollapsed(target.project, false).catch(() => undefined);
    void this.prefs.toggleSidebar();
  }

  private scrollTo(target: ScrollTarget, reveal = false): void {
    const root = this.host.nativeElement;
    const element =
      'needs' in target
        ? root.querySelector<HTMLElement>('[data-testid=needs-you]')
        : 'project' in target
          ? [...root.querySelectorAll<HTMLElement>('.pk-project')].find((p) => p.dataset['cwd'] === target.project)
          : [...root.querySelectorAll<HTMLElement>('.pk-thread')].find(
              (row) => row.dataset['thread'] === target.thread,
            );
    element?.scrollIntoView?.({ block: 'thread' in target ? 'nearest' : 'start' });
    if (!element || !reveal) return;
    element.setAttribute('data-reveal', '');
    setTimeout(() => element.removeAttribute('data-reveal'), 1600);
  }

  // ---- quick actions

  /** The project switcher: its latest thread opens (as ⌘1…9), or, with none, it becomes the current project; "+" and the panels follow. */
  protected switchProject(event: Event, index: number): void {
    closeMenu(event);
    this.store.jumpToProject(index);
  }

  protected projectCanWorktree(): boolean {
    return !!this.current()?.workspace.worktree?.git;
  }

  protected quickWorktree(): void {
    const project = this.current();
    if (!project || !project.workspace.worktree?.git) return;
    void this.create(project.workspace.cwd, 'worktree');
  }

  /** The Terminal panel, in the project's folder (the shell follows the open thread's folder, or the project's when no thread is open). */
  protected async quickTerminal(): Promise<void> {
    const project = this.current();
    if (!project) return;
    if (this.store.cwd() !== project.workspace.cwd) await this.store.selectWorkspace(project.workspace.cwd);
    this.bus.setPanel('terminal');
    this.closeDrawer();
  }

  /** The folder in view opens in the system's editor (the desktop app does it; a browser cannot). */
  protected async quickEditor(): Promise<void> {
    const project = this.current();
    if (!project || !this.desktop) return;
    const folder = this.store.selected()?.cwd === project.workspace.cwd ? this.store.folder() : project.workspace.cwd;
    try {
      const result = await unwrap(
        sessionOpenInEditor({
          client: this.api.client,
          path: { id: folder ?? project.workspace.cwd },
          body: { path: '.' },
        }),
      );
      if (!result.opened)
        this.toasts.show('info', result.reason ?? this.i18n.t('threads.threadSidebar.couldNotOpenTheFolder'));
    } catch (error) {
      this.toasts.show(
        'error',
        this.i18n.t('threads.threadSidebar.couldNotOpen', {
          value1: project.workspace.name,
          value2: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** The Changes panel on the working tree. It belongs to a thread, so the project's latest thread opens first when none of the project is open. */
  protected async quickChanges(): Promise<void> {
    const project = this.current();
    if (!project) return;
    if (this.store.selected()?.cwd !== project.workspace.cwd) {
      const latest = [...project.threads].sort(
        (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.updatedAt - a.updatedAt,
      )[0];
      if (!latest)
        return void this.toasts.show(
          'info',
          this.i18n.t('threads.threadSidebar.startAThreadInFirstTheChanges', { value1: project.workspace.name }),
        );
      this.opened.emit(latest.id);
      for (let i = 0; i < 30 && this.store.selectedId() !== latest.id; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.review.setSource('worktree');
    this.bus.setPanel('changes');
    this.closeDrawer();
  }

  /** Settings › Projects, on the project's own page once that exists (reads the project from the request). */
  protected quickSettings(): void {
    const project = this.current();
    this.closeDrawer();
    this.bus.openSettings('projects', undefined, project?.workspace.cwd);
  }

  /** On a phone the list is a drawer over the page: what an action opens is what the person looks at next. */
  private closeDrawer(): void {
    const drawer = document.getElementById('t-threads') as HTMLInputElement | null;
    if (drawer) drawer.checked = false;
  }

  /** A waiting badge or the waiting count of a project: the thread opens at its approval block. */
  protected openWaiting(event: Event, thread: ThreadSummary): void {
    event.stopPropagation();
    this.shell.openWaiting(thread.id);
    this.opened.emit(thread.id);
  }

  protected accept(event: Event, thread: ThreadSummary, suggestion: ThreadSuggestion): void {
    event.stopPropagation();
    // A drafted skill is read, not applied: the chip opens the thread and the review dialog (the decision is Approve or Discard there).
    if (suggestion.kind === 'learn') {
      this.opened.emit(thread.id);
      void this.learn.read(thread.id);
      return;
    }
    if (suggestion.kind === 'answer') this.opened.emit(thread.id);
    void this.shell.acceptSuggestion(thread, suggestion);
  }

  protected async dismissSuggestion(event: Event, suggestion: ThreadSuggestion): Promise<void> {
    closeMenu(event);
    await this.shell.dismissSuggestion(suggestion);
  }

  /**
   * A new thread: its page opens with the Where row. Without `mode` the row starts from the project's defaults ("+", ⌘N); the chevron menu's entries say
   * Local or Worktree and the row shows that. Nothing is made in git until the first message is sent.
   */
  protected async create(cwd?: string, mode?: 'local' | 'worktree'): Promise<void> {
    const thread = await this.store.create(cwd).catch(() => undefined);
    if (!thread) return;
    if (mode) await this.newThread.preset(thread, mode);
    this.opened.emit(thread.id);
  }

  /** The current project can have worktrees (it is a git repository). */
  protected canWorktree(): boolean {
    const cwd = this.store.workspace();
    return !!this.store.workspaces().find((w) => w.cwd === cwd)?.worktree?.git;
  }

  /** The branch a new worktree is cut from: the project's setting, else the checked-out branch. */
  protected worktreeBase(): string {
    const workspace = this.store.workspaces().find((w) => w.cwd === this.store.workspace());
    return workspace?.worktree?.base ?? workspace?.branch ?? this.i18n.t('threads.threadSidebar.theCurrentBranch');
  }

  protected async menuNewWorktree(event: Event, cwd: string): Promise<void> {
    closeMenu(event);
    await this.create(cwd, 'worktree');
  }

  protected async menuNewLocal(event: Event, cwd: string): Promise<void> {
    closeMenu(event);
    await this.create(cwd, 'local');
  }

  protected worktreeTitle(thread: ThreadSummary): string {
    const wt = thread.worktree;
    return wt
      ? this.i18n.t('threads.threadSidebar.worktreeCutFromInSyncMergeBack', {
          value1: wt.detached
            ? this.i18n.t('threads.threadSidebar.withoutABranchDetached')
            : this.i18n.t('threads.threadSidebar.on', {
                value1: wt.branch ?? this.i18n.t('threads.threadSidebar.aBranch'),
              }),
          value2: wt.base ?? this.i18n.t('threads.threadSidebar.theBase'),
          value3: wt.path,
        })
      : '';
  }

  // ---- hand off: each entry says why it is off when it does not apply

  /** Hand off to local: a worktree thread into the folder. */
  protected handoffReason(thread: ThreadSummary): string | undefined {
    if (!thread.worktree?.exists) return this.i18n.t('threads.threadSidebar.onlyAThreadInAWorktreeCan');
    if (thread.running) return this.i18n.t('threads.threadSidebar.stopTheRunFirstItsFilesAre');
    return undefined;
  }

  /** Move into a worktree: a Local thread into a new one. */
  protected moveReason(thread: ThreadSummary): string | undefined {
    if (thread.worktree?.exists) return this.i18n.t('threads.threadSidebar.thisThreadWorksInAWorktreeAlready');
    if (thread.messageCount === 0) return this.i18n.t('threads.threadSidebar.thisThreadHasNoMessageYetChoose');
    if (!this.store.workspaces().find((w) => w.cwd === thread.cwd)?.worktree?.git)
      return this.i18n.t('threads.threadSidebar.aWorktreeNeedsAGitRepositoryThis');
    if (thread.running) return this.i18n.t('threads.threadSidebar.stopTheRunFirstItsFilesAre');
    return undefined;
  }

  /** Create branch here: a worktree without a branch gets one. */
  protected branchReason(thread: ThreadSummary): string | undefined {
    if (!thread.worktree?.exists) return this.i18n.t('threads.threadSidebar.onlyAThreadInAWorktreeCane3491');
    if (!thread.worktree.detached) return this.i18n.t('threads.threadSidebar.thisWorktreeHasABranchAlready');
    if (thread.running) return this.i18n.t('threads.threadSidebar.stopTheRunFirst');
    return undefined;
  }

  protected async openHandoff(event: Event, thread: ThreadSummary, mode: 'handoff' | 'move'): Promise<void> {
    await this.openWorktree(event, thread, mode);
  }

  protected async createBranch(event: Event, thread: ThreadSummary): Promise<void> {
    closeMenu(event);
    const workspace = this.store.workspaces().find((w) => w.cwd === thread.cwd);
    const slug = (
      threadLabel(this.i18n.t, thread)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'work'
    ).slice(0, 40);
    const name = await this.dialogs.askName(
      `${workspace?.worktree?.branchPrefix ?? 'pi-kit/'}${slug}`,
      this.i18n.t('threads.threadSidebar.createBranchDialogTitle'),
      'feature/my-change',
    );
    if (!name) return;
    try {
      await unwrap(worktreeBranch({ client: this.api.client, path: { id: thread.id }, body: { name: name.trim() } }));
      await this.store.refresh();
    } catch {
      // the store shows the error in the footer
    }
  }

  /** Sync with base / Merge back from a row's menu: the thread opens first (the review mode and the panels follow it), then the dialog. */
  protected async openWorktree(
    event: Event,
    thread: ThreadSummary,
    mode: 'sync' | 'merge' | 'handoff' | 'move',
  ): Promise<void> {
    closeMenu(event);
    if (this.store.selectedId() !== thread.id) {
      this.opened.emit(thread.id);
      for (let i = 0; i < 30 && this.store.selectedId() !== thread.id; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // On a phone the list is a drawer over the page: the dialog is what the person looks at next.
    this.closeDrawer();
    await this.worktrees.openDialog(thread.id, mode);
  }

  // ---- projects

  protected toggleProject(event: Event, view: ProjectView): void {
    if ((event.target as HTMLElement).closest('.tail')) return;
    // Searching shows every match open; the fold is not changed by clicking then.
    if (this.query().trim()) return;
    void this.store.setCollapsed(view.project.workspace.cwd, view.expanded).catch(() => undefined);
  }

  protected async newThreadIn(event: Event, cwd: string): Promise<void> {
    event.stopPropagation();
    await this.create(cwd);
  }

  protected async menuNewThread(event: Event, cwd: string): Promise<void> {
    closeMenu(event);
    await this.create(cwd);
  }

  protected async menuFold(event: Event, view: ProjectView): Promise<void> {
    closeMenu(event);
    await this.store.setCollapsed(view.project.workspace.cwd, view.expanded).catch(() => undefined);
  }

  protected async menuHide(event: Event, cwd: string): Promise<void> {
    closeMenu(event);
    await this.store.setHidden(cwd, true).catch(() => undefined);
  }

  protected async menuMove(event: Event, cwd: string, offset: -1 | 1): Promise<void> {
    closeMenu(event);
    await this.store.stepProject(cwd, offset).catch(() => undefined);
  }

  protected async menuAttendant(event: Event, cwd: string, on: boolean): Promise<void> {
    closeMenu(event);
    await this.store.setAttendant(cwd, on).catch(() => undefined);
  }

  protected async showHidden(event: Event, cwd: string): Promise<void> {
    closeMenu(event);
    await this.store.setHidden(cwd, false).catch(() => undefined);
  }

  protected async toggleArchived(event: Event): Promise<void> {
    closeMenu(event);
    await this.store.toggleArchived();
  }

  protected openAttendantActivity(event: Event): void {
    closeMenu(event);
    this.bus.openSettings('attendant-activity');
  }

  // ---- drag and drop of the project groups

  protected dragStart(event: DragEvent, cwd: string): void {
    if (this.query().trim()) return event.preventDefault();
    event.dataTransfer?.setData('text/plain', cwd);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.dragging.set(cwd);
  }

  protected dragOver(event: DragEvent, cwd: string): void {
    const from = this.dragging();
    if (!from) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const where = event.clientY < box.top + box.height / 2 ? 'above' : 'below';
    const current = this.over();
    if (current?.cwd !== cwd || current.where !== where) this.over.set(from === cwd ? undefined : { cwd, where });
  }

  protected drop(event: DragEvent, cwd: string): void {
    const from = this.dragging();
    const target = this.over();
    event.preventDefault();
    this.dragEnd();
    if (!from || !target || from === cwd) return;
    // Dropped above a project: before it. Below it: before the one that follows it (none: the end).
    const others = this.store
      .visibleProjects()
      .map((p) => p.workspace.cwd)
      .filter((c) => c !== from);
    const before = target.where === 'above' ? cwd : others[others.indexOf(cwd) + 1];
    void this.store.moveProject(from, before).catch(() => undefined);
  }

  protected dragEnd(): void {
    this.dragging.set(undefined);
    this.over.set(undefined);
  }

  /** The folder picker of the desktop app; a browser has none, so it asks for the path (development). */
  protected async openFolder(event: Event): Promise<void> {
    closeMenu(event);
    const picked = window.piKit?.showOpenDialog
      ? await window.piKit.showOpenDialog()
      : await this.dialogs.askName(
          '',
          this.i18n.t('threads.threadSidebar.addProjectDialog'),
          '/absolute/path/to/the/folder',
        );
    if (picked) await this.store.openWorkspace(picked).catch(() => undefined); // the store shows the error in the footer
  }

  // ---- threads

  protected async togglePinned(event: Event, thread: ThreadSummary): Promise<void> {
    closeMenu(event);
    await this.store.setPinned(thread.id, !thread.pinned).catch(() => undefined); // the store shows the error in the footer
  }

  protected async toggleThreadArchived(event: Event, thread: ThreadSummary): Promise<void> {
    closeMenu(event);
    // Archiving a thread that has a worktree asks what happens to it.
    if (!thread.archived && thread.worktree?.exists) {
      this.archiving.set(thread);
      await this.readWorktree(thread);
      return;
    }
    await this.store.setArchived(thread.id, !thread.archived).catch(() => undefined);
  }

  /** Reads how many uncommitted changes the worktree holds, for the keep / remove question. */
  private async readWorktree(thread: ThreadSummary): Promise<void> {
    this.leaving.set({ dirty: undefined, choice: 'keep' });
    const dirty = await unwrap(worktreeState({ client: this.api.client, path: { id: thread.id } })).then(
      (s) => s.dirty,
      () => 0,
    );
    this.leaving.update((l) => ({ ...l, dirty }));
  }

  protected chooseWorktree(choice: 'keep' | 'remove'): void {
    this.leaving.update((l) => ({ ...l, choice }));
  }

  protected async confirmArchive(): Promise<void> {
    const thread = this.archiving();
    const { dirty, choice } = this.leaving();
    this.archiving.set(undefined);
    if (!thread) return;
    try {
      // A worktree with changes the person said to drop goes with force; a clean one the plain way.
      if (choice === 'remove' && (dirty ?? 0) > 0)
        await unwrap(worktreeRemove({ client: this.api.client, path: { id: thread.id }, body: { force: true } }));
      await this.store.setArchived(thread.id, true, choice === 'remove' && !(dirty ?? 0) ? 'remove' : undefined);
    } catch {
      // the store shows the error in the footer
    }
  }

  protected async fork(event: Event, thread: ThreadSummary): Promise<void> {
    closeMenu(event);
    const forked = await this.store.fork(thread.id).catch(() => undefined);
    if (forked) this.opened.emit(forked.id);
  }

  protected async clone(event: Event, thread: ThreadSummary): Promise<void> {
    closeMenu(event);
    const cloned = await this.store.clone(thread.id).catch(() => undefined);
    if (cloned) this.opened.emit(cloned.id);
  }

  protected startRename(event: Event, thread: ThreadSummary): void {
    closeMenu(event);
    this.renaming.set(thread.id);
  }

  protected async commitRename(thread: ThreadSummary, input: HTMLInputElement): Promise<void> {
    if (this.renaming() !== thread.id) return;
    this.renaming.set(undefined);
    const title = input.value.trim();
    if (title && title !== thread.title) await this.store.rename(thread.id, title).catch(() => undefined);
  }

  protected askDelete(event: Event, thread: ThreadSummary): void {
    closeMenu(event);
    this.deleting.set(thread);
    this.leaving.set({ dirty: 0, choice: 'keep' });
    if (thread.worktree?.exists) void this.readWorktree(thread);
  }

  protected async confirmDelete(): Promise<void> {
    const thread = this.deleting();
    const { dirty, choice } = this.leaving();
    this.deleting.set(undefined);
    if (!thread) return;
    const worktree =
      thread.worktree?.exists && choice === 'remove' ? ((dirty ?? 0) > 0 ? 'force' : 'remove') : undefined;
    await this.store.remove(thread.id, worktree).catch(() => undefined);
  }
}

/** daisyUI's `<details class="dropdown">` stays open after a click inside it; close it by hand. */
function closeMenu(event: Event): void {
  (event.target as HTMLElement | null)?.closest('details')?.removeAttribute('open');
}
