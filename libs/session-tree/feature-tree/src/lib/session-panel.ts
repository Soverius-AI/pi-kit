import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, effect, inject, signal, viewChild } from '@angular/core';
import { PkContextMenu, type PkMenuItem } from '@pi-kit/ui';
import { type GraphActionEvent, PkSessionGraph } from '@pi-kit/session-tree/ui';
import type { ContextKind, SessionContext, TreeRow } from '@pi-kit/protocol';
import { compactNumber } from '@pi-kit/ui';
import { UiStore } from '@pi-kit/data-access';
import { GraphStore } from '@pi-kit/session-tree/data';

/**
 * The session side panel: "Session", the turn and fork count, a Turns /
 * Entries toggle and close in the bar, "Find a turn" and "Fold side branches" under it, the git-style graph (36px rows with inline
 * actions, abandoned branches folded into group rows, windowed past 200 rows) or the raw entries, and a sticky foot with the position
 * in the session and "Jump to current". Hovering a turn tints it in the transcript; clicking one on the active path scrolls the
 * transcript to it without moving the leaf. The shell decides whether the panel is open and how it overlays (layout.css).
 */
@Component({
  selector: 'pk-session-panel',
  imports: [PkSessionGraph, PkContextMenu, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-panel', '[attr.aria-label]': "i18n.t('session-tree.sessionPanel.session')" },
  template: `
    <div class="pk-bar">
      <span class="font-medium">{{ 'session-tree.sessionPanel.session' | transloco }}</span>
      @if (state.tree()) {
        <span class="muted t-sm truncate">{{ state.summary() }}</span>
      }
      <div
        class="pk-seg pk-seg-xs ml-auto"
        role="group"
        [attr.aria-label]="'session-tree.sessionPanel.view' | transloco"
      >
        <button type="button" [attr.aria-pressed]="state.view() === 'turns'" (click)="state.setView('turns')">
          {{ 'session-tree.sessionPanel.turns' | transloco }}
        </button>
        <button type="button" [attr.aria-pressed]="state.view() === 'entries'" (click)="state.setView('entries')">
          {{ 'session-tree.sessionPanel.entries' | transloco }}
        </button>
        <button
          type="button"
          data-testid="view-context"
          [attr.aria-pressed]="state.view() === 'context'"
          (click)="state.setView('context')"
        >
          {{ 'session-tree.sessionPanel.context' | transloco }}
        </button>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-xs btn-square"
        [title]="'session-tree.sessionPanel.close' | transloco"
        [attr.aria-label]="'session-tree.sessionPanel.closeTheSessionPanel' | transloco"
        (click)="bus.closePanel()"
      >
        ✕
      </button>
    </div>

    @if (state.view() === 'turns' && state.tree()) {
      <div class="px-3 py-2 flex items-center gap-2" style="border-bottom: 1px solid var(--color-base-300)">
        <input
          type="search"
          class="input input-xs flex-1 min-w-0"
          [placeholder]="'session-tree.sessionPanel.findATurn' | transloco"
          [attr.aria-label]="'session-tree.sessionPanel.findATurn' | transloco"
          [value]="state.query()"
          (input)="state.setQuery($any($event.target).value)"
          (keydown.escape)="clearFind($event)"
        />
        <label class="t-xs muted flex items-center gap-1 whitespace-nowrap"
          ><input
            type="checkbox"
            class="toggle toggle-xs"
            [checked]="state.fold()"
            (change)="state.setFold($any($event.target).checked)"
          />
          {{ 'session-tree.sessionPanel.foldSideBranches' | transloco }}</label
        >
      </div>
    }

    @if (state.error() && !state.tree()) {
      <p class="p-4 text-sm text-error" role="alert">
        {{ 'session-tree.sessionPanel.theSessionGraphCouldNotBeLoaded' | transloco: { value1: state.error() } }}
      </p>
    } @else if (state.view() === 'context') {
      <!-- The context inspector: what the model sees right now, by kind and piece, with pi's token estimate for each. -->
      @if (state.context(); as context) {
        <div class="pk-context" data-testid="context-inspector">
          <div class="head">
            <b data-testid="context-total">{{ contextLine(context) }}</b>
            @if (context.contextWindow) {
              <progress
                class="progress progress-primary w-full"
                [value]="context.contextTokens ?? context.estimatedTokens"
                [max]="context.contextWindow"
              ></progress>
            }
            <span class="t-xs muted">{{ 'session-tree.sessionPanel.estimateNote' | transloco }}</span>
          </div>
          <div class="groups" role="list" [attr.aria-label]="'session-tree.sessionPanel.contextByKind' | transloco">
            @for (group of context.groups; track group.kind) {
              <div role="listitem" class="group" [attr.data-kind]="group.kind">
                <button
                  type="button"
                  class="row"
                  [attr.aria-expanded]="open().has(group.kind)"
                  (click)="toggle(group.kind)"
                >
                  <span class="chev" aria-hidden="true">{{ open().has(group.kind) ? '▾' : '▸' }}</span>
                  <span class="lbl">{{ kindLabel(group.kind) }}</span>
                  <span class="muted t-xs">{{ group.count }}</span>
                  <span class="share"><span class="fill" [style.width.%]="share(context, group.tokens)"></span></span>
                  <span class="num">{{ tokens(group.tokens) }}</span>
                </button>
                @if (open().has(group.kind)) {
                  @for (item of itemsOf(context, group.kind); track item.id) {
                    <details class="item" [attr.data-source]="item.source">
                      <summary>
                        <span class="lbl truncate" [title]="item.label">{{ item.label }}</span>
                        @if (item.turn) {
                          <span class="muted t-xs">{{
                            'session-tree.sessionPanel.turnN' | transloco: { value1: item.turn }
                          }}</span>
                        }
                        @if (item.source && !item.source.startsWith(item.kind)) {
                          <span class="muted t-xs mono">{{ item.source }}</span>
                        }
                        <span class="num">{{ tokens(item.tokens) }}</span>
                      </summary>
                      <pre class="text">{{ item.text }}</pre>
                      @if (item.truncated) {
                        <p class="t-xs muted m-0 px-2">{{ 'session-tree.sessionPanel.cutOff' | transloco }}</p>
                      }
                    </details>
                  }
                }
              </div>
            }
          </div>
        </div>
      } @else if (state.loading()) {
        <p class="px-4 py-2 text-sm text-muted" role="status">
          {{ 'session-tree.sessionPanel.readingTheContext' | transloco }}
        </p>
      } @else {
        <p class="px-4 py-2 text-sm text-muted">{{ 'session-tree.sessionPanel.noContextYet' | transloco }}</p>
      }
    } @else if (state.tree(); as tree) {
      @if (state.view() === 'turns') {
        <pk-session-graph
          [tree]="tree"
          [selectedId]="state.selectedId()"
          [fold]="state.fold()"
          [expanded]="state.expanded()"
          [query]="state.query()"
          (pick)="state.pick($event)"
          (activate)="state.goHereById($event)"
          (hover)="state.hover($event)"
          (action)="onAction($event)"
          (toggleGroup)="state.toggleGroup($event)"
        />
        <div class="pk-graph-foot">
          @if (state.busy(); as busy) {
            <span class="flex items-center gap-2" role="status"
              ><span class="loading loading-spinner loading-xs"></span>{{ busy }}…</span
            >
          } @else {
            <span>{{ state.position() }}</span>
            @if (state.path()) {
              <span aria-hidden="true">·</span>
              <span class="truncate">{{ state.path() }}</span>
            }
          }
          <button type="button" class="btn btn-link btn-xs ml-auto no-underline" (click)="jump()">
            {{ 'session-tree.sessionPanel.jumpToCurrent' | transloco }}
          </button>
        </div>
      } @else {
        <div
          class="flex-1 overflow-y-auto py-2"
          role="list"
          [attr.aria-label]="'session-tree.sessionPanel.sessionEntries' | transloco"
        >
          @for (entry of state.entries(); track entry.id) {
            <div
              role="listitem"
              class="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 px-4 py-1 mono t-xs"
              [class.text-primary]="entry.leaf"
            >
              <span class="muted text-right">{{ entry.index }}</span>
              <span
                class="line-clamp-6 break-words"
                [title]="entry.text ? entry.title + ': ' + entry.text : entry.title"
                data-testid="entry-line"
                >{{ entry.type }}<span class="muted"> {{ entry.id }}{{ entry.parent ? ' ← ' + entry.parent : '' }}</span
                >{{ entry.text ? '  ' + entry.text : '' }}</span
              >
            </div>
          } @empty {
            <p class="px-4 py-2 text-sm text-muted">
              {{ 'session-tree.sessionPanel.thisSessionHasNoEntriesYet' | transloco }}
            </p>
          }
          @if (state.entriesHidden() > 0) {
            <p class="px-4 py-2 text-sm text-muted">
              {{
                'session-tree.sessionPanel.moreEntriesAreNotListedHereExport'
                  | transloco: { value1: state.entriesHidden() }
              }}
            </p>
          }
        </div>
      }
    } @else {
      <p class="p-4 text-sm text-muted">{{ 'session-tree.sessionPanel.loadingTheSessionGraph' | transloco }}</p>
    }

    @if (more(); as m) {
      <pk-context-menu
        [items]="m.items"
        [x]="m.x"
        [y]="m.y"
        [label]="'session-tree.sessionPanel.moreActionsForThisTurn' | transloco"
        (chosen)="chooseMore($event)"
        (dismissed)="more.set(undefined)"
      />
    }
  `,
})
export class SessionPanel {
  // ---- the context inspector
  /** The kinds whose pieces are listed; a group is folded to its line until opened. */
  protected readonly open = signal<ReadonlySet<ContextKind>>(new Set());
  protected toggle(kind: ContextKind): void {
    this.open.update((set) => {
      const next = new Set(set);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  }
  protected readonly tokens = compactNumber;
  /** "48.2k of 200k tokens in context (estimate 46.9k)", or the estimate alone before the model reported a size. */
  protected contextLine(context: SessionContext): string {
    const estimate = compactNumber(context.estimatedTokens);
    if (context.contextTokens === null)
      return this.i18n.t('session-tree.sessionPanel.contextEstimated', { value1: estimate });
    const window = context.contextWindow ? compactNumber(context.contextWindow) : '?';
    return this.i18n.t('session-tree.sessionPanel.contextOf', {
      value1: compactNumber(context.contextTokens),
      value2: window,
      value3: estimate,
    });
  }
  protected share(context: SessionContext, tokens: number): number {
    return context.estimatedTokens ? Math.round((tokens / context.estimatedTokens) * 100) : 0;
  }
  protected kindLabel(kind: ContextKind): string {
    return this.i18n.t(`session-tree.sessionPanel.kind.${kind}`);
  }
  protected itemsOf(context: SessionContext, kind: ContextKind) {
    return context.items.filter((item) => item.kind === kind).sort((a, b) => b.tokens - a.tokens);
  }

  protected readonly i18n = inject(Language);
  protected readonly state = inject(GraphStore);
  protected readonly bus = inject(UiStore);
  private readonly graph = viewChild(PkSessionGraph);

  /** The "More" menu of a turn row: local UI state. */
  protected readonly more = signal<{ x: number; y: number; row: TreeRow; items: PkMenuItem[] } | undefined>(undefined);

  constructor() {
    // A tint left on the transcript must not outlive the panel.
    effect((onCleanup) => onCleanup(() => this.state.clearHover()));
  }

  protected clearFind(event: Event): void {
    if (this.state.query()) {
      event.preventDefault();
      this.state.setQuery('');
    }
  }

  protected jump(): void {
    this.state.jumpToCurrent();
    this.graph()?.scrollToLeaf();
  }

  protected onAction(event: GraphActionEvent): void {
    const { row } = event;
    this.state.select(row.id);
    switch (event.id) {
      case 'go':
        return void this.state.goHere(row);
      case 'edit':
        return void this.state.editAndBranch(row);
      case 'fork':
        return void this.state.forkToThread(row);
      case 'label':
        return void this.state.label(row);
      case 'more': {
        const box = event.anchor.getBoundingClientRect();
        this.more.set({
          x: box.right - 180,
          y: box.bottom + 4,
          row,
          items: [
            {
              id: 'summarize',
              label: this.i18n.t('session-tree.sessionPanel.summarizeBranch'),
              disabled: !row.endId || row.isLeaf,
            },
            { id: 'entries', label: this.i18n.t('session-tree.sessionPanel.showInEntries') },
          ],
        });
      }
    }
  }

  protected chooseMore(id: string): void {
    const row = this.more()?.row;
    this.more.set(undefined);
    if (!row) return;
    if (id === 'summarize') void this.state.summarize(row);
    else if (id === 'entries') this.state.setView('entries');
  }
}
