import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  treeEntry,
  sessionContext,
  treeGet,
  treeLabel,
  treeNavigate,
  treeSummarize,
  unwrap,
} from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import {
  DialogStore,
  OVERLAY_BELOW_PX,
  UiStore,
  readStorage,
  withRequestStatus,
  withSelection,
  writeStorage,
} from '@pi-kit/data-access';
import type { SessionContext, SessionTree, TreeRow } from '@pi-kit/protocol';
import { footPath, pathCrumbs, positionLine, treeSummary } from '@pi-kit/session-tree/util';
import { ThreadsStore } from '@pi-kit/threads/api';
import { DEFAULT_TREE_POLICY, TREE_POLICY } from './tree-policy';

/** The turn the composer is about to branch from ("Edit and branch", ↑ in an empty composer). */
export interface BranchDraft {
  /** The user message entry to branch from; the new message becomes its sibling. */
  entryId: string;
  turn: number;
  text: string;
}

export interface RawTree {
  entries: Record<string, unknown>[];
  leafId: string | null;
}

/** One line of the Entries view's inspector. */
export interface EntryLine {
  index: number;
  id: string;
  parent: string;
  type: string;
  text: string;
  title: string;
  leaf: boolean;
}

interface GraphState {
  tree: SessionTree | undefined;
  view: 'turns' | 'entries' | 'context';
  raw: RawTree | undefined;
  /** The context inspector's answer: what the model sees, piece by piece; undefined until the view was opened. */
  context: SessionContext | undefined;
  /** What the card is waiting for ("Moving to turn 4"); the buttons are disabled meanwhile. */
  busy: string | undefined;
  branch: BranchDraft | undefined;
  /** "Fold side branches" (remembered per thread, on by default), the branches the user unfolded meanwhile, and "Find a turn". */
  fold: boolean;
  expanded: ReadonlySet<string>;
  query: string;
}

const FOLD_KEY = 'pk.graph.fold.';
const TRANSCRIPT = 'pk-transcript';

/** The remembered "Fold side branches" of a thread; folded when nothing was chosen. */
function readFold(threadId: string | undefined): boolean {
  return !threadId || readStorage(FOLD_KEY + threadId) !== '0';
}

const describe = (translate: Translate, row: TreeRow): string =>
  row.kind === 'turn' && row.turn ? translate('session-tree.graphStore.turn', { value1: row.number }) : row.preview;

/** What a system message of the session says: which prompt sections it sets or removes, with the "other agents" section in words. */
function systemText(translate: Translate, sections: Record<string, string | null> | undefined): string {
  if (!sections) return translate('session-tree.graphStore.systemPrompt');
  const parts = Object.entries(sections).map(([name, body]) => {
    if (body === null) return `-${name}`;
    // The coordination section is what the person looks for here: its text, without the tag around it.
    if (name === 'other_agents')
      return `${name}: ${body
        .replace(/<\/?other_agents>/g, '')
        .replace(/\s+/g, ' ')
        .trim()}`;
    return name;
  });
  return translate('session-tree.graphStore.sections', { value1: parts.join(', ') });
}

/** One line of what an entry says, for the inspector. */
export function entryText(
  translate: Translate,
  entry: Record<string, unknown>,
  skillEntryChars = DEFAULT_TREE_POLICY.skillEntryChars,
): string {
  const message = entry['message'] as
    { role?: string; content?: unknown; sections?: Record<string, string | null> } | undefined;
  if (entry['type'] === 'message' && message?.role === 'system')
    return systemText(translate, message.sections).slice(0, 600);
  // An extension's message in front of the model (pi-kit's notice that another thread changed a file) shows what it said.
  if (entry['type'] === 'custom_message') {
    const said = entry['content'];
    const text =
      typeof said === 'string'
        ? said
        : Array.isArray(said)
          ? said
              .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
              .join(' ')
          : '';
    return `${String(entry['customType'] ?? '')}: ${text}`.replace(/\s+/g, ' ').trim().slice(0, 600);
  }
  // An entry an extension (or pi-kit: the review batch, the skill chips) wrote beside the conversation: its type and what it holds.
  if (entry['type'] === 'custom')
    return `${String(entry['customType'] ?? '')}: ${JSON.stringify(entry['data'] ?? null)}`.slice(0, 600);
  const content =
    entry['type'] === 'message'
      ? message?.content
      : (entry['summary'] ?? entry['name'] ?? entry['label'] ?? entry['modelId'] ?? entry['thinkingLevel']);
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
            .join(' ')
        : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  // A user message that holds skill instructions (a `/skill:` pi expanded, or chips) shows more of what pi got: the blocks are what the person looks for here.
  return flat.slice(
    0,
    entry['type'] === 'message' && message?.role === 'user' && flat.includes('<skill name="') ? skillEntryChars : 120,
  );
}

/**
 * The session graph of the selected thread: the tree as the backend computed it, the
 * selection, the raw entries for the inspector, and the actions of the selected-turn card. Moving the leaf
 * (go here, edit and branch, summarise) goes through REST; the transcript then resets from the `MESSAGES_SNAPSHOT`
 * the backend wrote to the thread's log, by replaying it (`ChatStore.reconnectAndWait`).
 *
 * It also holds the graph and the transcript pointing at each other: hovering a turn of the graph tints that turn in the
 * transcript, and clicking a turn on the active path scrolls the transcript to it without moving the leaf. That works on the
 * DOM because the transcript owns its own rendering (and draws only the newest messages of a long thread): a user block carries the pi entry id
 * of its message in `data-block` when it came from the session file, and "Turn N" in its caption otherwise (a turn typed in this
 * window, until the thread is replayed). A turn that is not drawn is approached by scroll position and found again once the window has moved there.
 */
export const GraphStore = signalStore(
  { providedIn: 'root' },
  withState<GraphState>({
    tree: undefined,
    view: 'turns',
    raw: undefined,
    context: undefined,
    busy: undefined,
    branch: undefined,
    fold: true,
    expanded: new Set<string>(),
    query: '',
  }),
  withProps(() => ({ _policy: inject(TREE_POLICY) })),
  withRequestStatus(),
  withSelection(),
  withComputed(({ _policy, tree, selectedId, raw }) => {
    const translate = inject(Language).t;
    return {
      selectedRow: computed<TreeRow | undefined>(() => tree()?.rows.find((r) => r.id === selectedId())),
      crumbs: computed(() => pathCrumbs(translate, tree())),
      summary: computed(() => {
        const t = tree();
        return t ? treeSummary(translate, t) : '';
      }),
      position: computed(() => {
        const t = tree();
        return t ? positionLine(translate, t) : '';
      }),
      path: computed(() => footPath(translate, tree())),
      /** The number of turns on the active path, for a transcript that is not fully drawn. */
      activeTurns: computed(() => (tree()?.rows ?? []).filter((r) => r.onActivePath && r.kind === 'turn').length),
      /** The Entries view's lines. */
      entries: computed<EntryLine[]>(() => {
        const r = raw();
        if (!r) return [];
        return r.entries.slice(0, _policy.entryLimit).map((entry, i) => {
          const e = entry as { id: string; type: string; parentId?: string | null; message?: { role?: string } };
          return {
            index: i + 1,
            id: e.id,
            parent: e.parentId ?? '',
            type: e.type === 'message' ? (e.message?.role ?? 'message') : e.type,
            text: entryText(translate, entry, _policy.skillEntryChars),
            title: `${e.type} ${e.id}`,
            leaf: e.id === r.leafId,
          };
        });
      }),
      entriesHidden: computed(() => Math.max(0, (raw()?.entries.length ?? 0) - _policy.entryLimit)),
      /**
       * Branch navigation on user messages: for every turn row, the turns that continue from the same row (its siblings,
       * oldest first) and its place among them. The user message id of a transcript is the pi entry id of the turn row.
       */
      branches: computed(() => {
        const rows = tree()?.rows ?? [];
        const byParent = new Map<string, TreeRow[]>();
        for (const row of rows) {
          if (row.kind !== 'turn' || row.parentId === null) continue;
          byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
        }
        const out = new Map<string, { index: number; count: number; siblings: TreeRow[] }>();
        for (const siblings of byParent.values()) {
          if (siblings.length < 2) continue;
          const ordered = [...siblings].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
          ordered.forEach((row, index) => out.set(row.id, { index, count: ordered.length, siblings: ordered }));
        }
        return out;
      }),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const session = inject(ChatStore);
    const dialogs = inject(DialogStore);
    const ui = inject(UiStore);
    let abort: AbortController | undefined;
    let marked: Element[] = [];

    // ---- the transcript pointing back (DOM)

    const userBlock = (row: TreeRow): Element | undefined => {
      const host = document.querySelector(TRANSCRIPT);
      if (!host) return undefined;
      const byId = host.querySelector(`[data-block="${CSS.escape(row.id)}"]`);
      if (byId) return byId;
      for (const el of Array.from(host.querySelectorAll('pk-turn[role="user"]'))) {
        if (el.querySelector('.pk-when')?.textContent?.trim() === `Turn ${row.turn}`) return el;
      }
      return undefined;
    };

    const clearSync = (): void => {
      for (const el of marked) el.classList.remove('pk-sync');
      marked = [];
    };

    /** Tints the turn of `row` (its user block and the answer after it), or clears the tint when `row` is `undefined`. */
    const hoverRow = (row: TreeRow | undefined): void => {
      clearSync();
      if (!row || !row.onActivePath || row.kind !== 'turn') return;
      const block = userBlock(row);
      if (!block) return;
      // The turn is a row of pieces: the user block and every piece of the answer, which carry the user message's id as `data-after`.
      const els: Element[] = [
        block,
        ...Array.from(
          document.querySelectorAll(
            `${TRANSCRIPT} pk-turn[data-after="${CSS.escape(block.getAttribute('data-block') ?? '')}"]`,
          ),
        ),
      ];
      for (const el of els) el.classList.add('pk-sync');
      marked = els;
    };

    /** Reveals an active-path turn through the virtual viewport. */
    const reveal = async (row: TreeRow): Promise<void> => {
      if (!row.onActivePath || row.kind !== 'turn' || !row.turn) return;
      const viewport = document.querySelector(`${TRANSCRIPT} [pkVirtualTranscript]`);
      if (!viewport) return;
      for (let attempt = 0; attempt < 4; attempt++) {
        const block = userBlock(row);
        if (block) {
          block.scrollIntoView({ block: 'start', behavior: attempt === 0 ? 'smooth' : 'auto' });
          hoverRow(row);
          return;
        }
        viewport.dispatchEvent(new CustomEvent('pk-reveal-message', { detail: { id: row.id } }));
        await new Promise((resolve) => setTimeout(resolve, 160));
      }
    };

    const rowById = (rowId: string): TreeRow | undefined => store.tree()?.rows.find((r) => r.id === rowId);

    const methods = {
      /** Starts a thread from nothing: called when the selection changes. */
      reset(threadId: string | undefined): void {
        abort?.abort();
        patchState(store, {
          context: undefined,
          fold: readFold(threadId),
          expanded: new Set<string>(),
          query: '',
          tree: undefined,
          raw: undefined,
          selectedId: undefined,
          branch: undefined,
        });
        store.clearError();
      },

      async refresh(threadId = threads.selectedId()): Promise<void> {
        if (!threadId) return;
        abort?.abort();
        const current = (abort = new AbortController());
        store.requestStarted();
        try {
          const [tree, raw, context] = await Promise.all([
            unwrap(treeGet({ client: api.client, path: { id: threadId }, signal: current.signal })).then((answer) => {
              if (!('rows' in answer))
                throw new Error(translate('session-tree.graphStore.theBackendAnsweredTheSessionTreeWith'));
              return answer;
            }),
            store.view() === 'entries'
              ? unwrap(treeGet({ client: api.client, path: { id: threadId }, query: { raw: '1' } })).then((answer) => {
                  if (!('entries' in answer))
                    throw new Error(translate('session-tree.graphStore.theBackendAnsweredTheRawEntriesWith'));
                  return {
                    entries: answer.entries.filter(
                      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
                    ),
                    leafId: answer.leafId,
                  };
                })
              : Promise.resolve(undefined),
            store.view() === 'context'
              ? unwrap(sessionContext({ client: api.client, path: { id: threadId }, signal: current.signal }))
              : Promise.resolve(undefined),
          ]);
          if (current.signal.aborted || threads.selectedId() !== threadId) return;
          patchState(store, { tree, raw, ...(context ? { context } : {}) });
          store.requestDone();
          const selected = store.selectedId();
          if (!selected || !tree.rows.some((r) => r.id === selected)) store.setSelected(tree.leafRowId);
        } catch (error) {
          if (current.signal.aborted) return;
          store.requestFailed(error);
        } finally {
          // An aborted refresh leaves the status to the one that replaced it.
          if (abort === current && store.loading()) store.requestDone();
        }
      },

      select(rowId: string): void {
        store.setSelected(rowId);
      },
      setView(view: 'turns' | 'entries' | 'context'): void {
        patchState(store, { view });
      },
      /** The composer's context ring asks for the inspector: the Session panel opens on the context view. */
      showContext(): void {
        patchState(store, { view: 'context' });
        ui.setPanel('tree');
      },
      setQuery(query: string): void {
        patchState(store, { query });
      },

      setFold(on: boolean): void {
        patchState(store, { fold: on });
        const id = threads.selectedId();
        if (id) writeStorage(FOLD_KEY + id, on ? '1' : '0');
      },

      toggleGroup(groupId: string): void {
        patchState(store, (s) => {
          const next = new Set(s.expanded);
          if (!next.delete(groupId)) next.add(groupId);
          return { expanded: next };
        });
      },

      // ---- intent from the graph view

      /** A click on a row: select it, and on the active path bring the transcript to that turn (the leaf stays where it is). */
      pick(rowId: string): void {
        store.setSelected(rowId);
        const row = rowById(rowId);
        if (row) void reveal(row);
      },
      /** The pointer over a row tints its turn in the transcript. */
      hover(rowId: string | undefined): void {
        hoverRow(rowId ? rowById(rowId) : undefined);
      },
      clearHover: clearSync,
      /** Double click or Enter on a row. */
      goHereById(rowId: string): void {
        const row = rowById(rowId);
        if (row) void methods.goHere(row);
      },
      /** "Jump to current": the leaf row becomes the selection. */
      jumpToCurrent(): string | undefined {
        const leaf = store.tree()?.leafRowId;
        if (leaf) store.setSelected(leaf);
        return leaf ?? undefined;
      },

      // ---- the actions of the selected-turn card

      /** Moves the leaf to the end of the row and resets the transcript to that branch. */
      async goHere(row: TreeRow): Promise<void> {
        if (!row.endId || row.isLeaf) return;
        await move(row.endId, translate('session-tree.graphStore.movingTo', { value1: describe(translate, row) }));
      },

      /** "Summarize branch": go to the row, carrying a model-written summary of the branch being left. */
      async summarize(row: TreeRow): Promise<void> {
        if (!row.endId) return;
        await move(
          row.endId,
          translate('session-tree.graphStore.summarizingTheBranchAndMovingTo', { value1: describe(translate, row) }),
          true,
        );
      },

      /** Puts the user text into the composer; submitting moves to the turn's parent and prompts from there. */
      async editAndBranch(row: TreeRow): Promise<void> {
        const threadId = threads.selectedId();
        if (!threadId || row.kind !== 'turn' || !row.turn) return;
        try {
          const entry = await unwrap(treeEntry({ client: api.client, path: { id: threadId, entryId: row.id } }));
          if (!entry.text) return session.say('info', translate('session-tree.graphStore.thatTurnHasNoTextToEdit'));
          methods.beginBranch({ entryId: row.id, turn: row.turn, text: entry.text });
        } catch (error) {
          session.say('error', translate('session-tree.graphStore.editAndBranch', { value1: errorMessage(error) }));
        }
      },

      /** Branch navigation: moves to the sibling at `index` and, below it, to the end of the newest line of turns (the branch as it was left). */
      async switchBranch(userMessageId: string, index: number): Promise<void> {
        const branch = store.branches().get(userMessageId);
        const target = branch?.siblings[index];
        if (!branch || !target || index === branch.index) return;
        const rows = store.tree()?.rows ?? [];
        let end: TreeRow = target;
        for (;;) {
          const children = rows.filter((r) => r.parentId === end.id && r.kind !== 'ghost');
          if (children.length === 0) break;
          end = [...children].sort((a, b) =>
            (b.time ?? b.timestamp ?? '').localeCompare(a.time ?? a.timestamp ?? ''),
          )[0];
        }
        if (!end.endId) return;
        await move(end.endId, translate('session-tree.graphStore.movingToTurn', { value1: target.number }));
      },

      /** Edit on a user message: its text goes into the composer, and sending it branches from that turn. */
      async editMessage(userMessageId: string): Promise<void> {
        const row = store.tree()?.rows.find((r) => r.id === userMessageId && r.kind === 'turn');
        if (row) return methods.editAndBranch(row);
        session.say('info', translate('session-tree.graphStore.thatMessageIsNotInTheSession'));
      },

      /** ↑ in an empty composer: the newest turn of the active path. */
      async recallLast(): Promise<boolean> {
        const threadId = threads.selectedId();
        if (!threadId) return false;
        try {
          let tree = store.tree();
          if (!tree) {
            const answer = await unwrap(treeGet({ client: api.client, path: { id: threadId } }));
            if (!('rows' in answer))
              throw new Error(translate('session-tree.graphStore.theBackendAnsweredTheSessionTreeWith'));
            tree = answer;
          }
          const last = [...tree.rows].reverse().find((r) => r.kind === 'turn' && r.onActivePath);
          if (!last) return false;
          await methods.editAndBranch(last);
          return store.branch() !== undefined;
        } catch {
          return false;
        }
      },

      /** A new thread with the path up to the row; it becomes the selection. */
      async forkToThread(row: TreeRow): Promise<void> {
        const threadId = threads.selectedId();
        if (!threadId || !row.endId || row.kind === 'root') return;
        patchState(store, { busy: translate('session-tree.graphStore.forkingIntoANewThread') });
        try {
          const created = await threads.fork(threadId, row.endId);
          threads.select(created.id);
          session.say(
            'info',
            translate('session-tree.graphStore.forkedIntoANewThread', { value1: describe(translate, row) }),
          );
        } catch (error) {
          session.say('error', translate('session-tree.graphStore.forkToNewThread', { value1: errorMessage(error) }));
        } finally {
          patchState(store, { busy: undefined });
        }
      },

      /** The entry a label is written on: a turn's user message, a compaction or summary entry; for the root row its last entry. */
      labelTarget(row: TreeRow): string | undefined {
        if (row.kind === 'ghost') return undefined;
        return row.kind === 'root' ? (row.endId ?? undefined) : row.id;
      },

      async label(row: TreeRow): Promise<void> {
        const threadId = threads.selectedId();
        const target = methods.labelTarget(row);
        if (!threadId || !target) return;
        const answer = await dialogs.askName(
          row.label ?? '',
          translate('session-tree.graphStore.label', { value1: describe(translate, row) }),
          translate('session-tree.graphStore.labelEmptyToClear'),
        );
        if (answer === undefined) return;
        patchState(store, { busy: translate('session-tree.graphStore.savingTheLabel') });
        try {
          patchState(store, {
            tree: await unwrap(
              treeLabel({
                client: api.client,
                path: { id: threadId },
                body: { targetId: target, label: answer || null },
              }),
            ),
          });
          void threads.refresh();
        } catch (error) {
          session.say('error', translate('session-tree.graphStore.labelcaef6', { value1: errorMessage(error) }));
        } finally {
          patchState(store, { busy: undefined });
        }
      },

      // ---- branching from the composer

      beginBranch(draft: BranchDraft): void {
        patchState(store, { branch: draft });
        ui.setComposerText(draft.text);
        ui.focusComposer();
        // The overlay would cover the composer the text is waiting in.
        if (window.innerWidth < OVERLAY_BELOW_PX) ui.closePanel();
      },

      cancelBranch(): void {
        patchState(store, { branch: undefined });
      },

      /**
       * Called by the composer when the user submits while a branch is pending: moves the leaf to the edited turn's parent
       * and waits for the transcript to show that branch, so the prompt that follows becomes its sibling.
       */
      async commitBranch(): Promise<void> {
        const draft = store.branch();
        const threadId = threads.selectedId();
        if (!draft || !threadId) return;
        patchState(store, { busy: translate('session-tree.graphStore.branchingFromTurn', { value1: draft.turn }) });
        try {
          // A user message as the target puts the leaf on its parent (pi's own rule for `/tree`).
          await unwrap(treeNavigate({ client: api.client, path: { id: threadId }, body: { targetId: draft.entryId } }));
          await session.reconnectAndWait();
          patchState(store, { branch: undefined });
        } finally {
          patchState(store, { busy: undefined });
        }
      },
    };

    const move = async (targetId: string, busy: string, summarize = false): Promise<void> => {
      const threadId = threads.selectedId();
      if (!threadId) return;
      patchState(store, { busy });
      try {
        if (summarize) await unwrap(treeSummarize({ client: api.client, path: { id: threadId }, body: { targetId } }));
        else await unwrap(treeNavigate({ client: api.client, path: { id: threadId }, body: { targetId } }));
        patchState(store, { branch: undefined });
        await session.reconnectAndWait();
        await methods.refresh(threadId);
        const leaf = store.tree()?.leafRowId;
        if (leaf) store.setSelected(leaf);
        void threads.refresh();
      } catch (error) {
        session.say('error', errorMessage(error));
      } finally {
        patchState(store, { busy: undefined });
      }
    };

    return methods;
  }),
  withHooks({
    onInit(store) {
      const threads = inject(ThreadsStore);
      const ui = inject(UiStore);
      // A different thread starts from nothing.
      effect(() => {
        const id = threads.selectedId();
        untracked(() => store.reset(id));
      });
      // Fetch (and refetch) when the thread changes, pi announces an entry or a new leaf, or the file changed under us.
      effect((onCleanup) => {
        const id = threads.selectedId();
        ui.treeStale();
        void threads.selected()?.updatedAt;
        store.view();
        if (!id) return;
        const timer = setTimeout(() => void store.refresh(id), store._policy.refetchDelayMs);
        onCleanup(() => clearTimeout(timer));
      });
    },
  }),
);
export type GraphStore = InstanceType<typeof GraphStore>;
