import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { fileIconKind, PkFileIcon, PkIcon } from '@pi-kit/design-system';
import { type FileLease, type FileNode, type GitBadge, type OtherAgentInfo } from '@pi-kit/protocol';
import { PATH_DRAG_TYPE, PkContextMenu } from '@pi-kit/ui';
import { type FileDecoration, formatMtime, formatSize, revertWords } from '@pi-kit/files/util';
import { UiStore } from '@pi-kit/data-access';
import { CoordinationStore } from '@pi-kit/threads/api';
import { FilesStore } from '@pi-kit/files/data';

/** The tints of a badge, as the Changes panel has them (literal class names so Tailwind finds them). */
const BADGE_CLASS = {
  success: 'bg-success/25 text-success',
  warning: 'bg-warning/25 text-warning',
  error: 'bg-error/25 text-error',
  info: 'bg-info/25 text-info',
} as const;
const DOT_CLASS = { success: 'bg-success', warning: 'bg-warning', error: 'bg-error', info: 'bg-info' } as const;
const DOT_TONE: Record<GitBadge, keyof typeof DOT_CLASS> = {
  C: 'error',
  D: 'error',
  M: 'warning',
  R: 'info',
  A: 'success',
  U: 'success',
};

/**
 * The Files side panel: the workspace folder as a tree that only lists what git does not ignore
 * (the same index `@` completion uses; "Show ignored" lists the rest, greyed), folders loaded when opened. Rows carry git's badge
 * (the Changes panel's tints), a dot on folders with changes inside, a π for files pi changed in this thread, a type icon and, at
 * 1440 and wider, size and time. It follows the folder live (one watcher shared with the Changes panel). A right click or ⌘-click
 * opens the context menu; the keyboard walks the tree, type-ahead jumps by name, ⌘⇧F focuses the filter and Enter opens the diff of
 * a changed file or inserts `@path`. Dragging a row into the composer inserts `@path` too.
 */
@Component({
  selector: 'pk-files-panel',
  imports: [NgTemplateOutlet, PkContextMenu, PkFileIcon, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-panel', '[attr.aria-label]': "i18n.t('files.filesPanel.files')" },
  template: `
    <div class="pk-bar">
      <span class="font-medium">{{ 'files.filesPanel.files' | transloco }}</span>
      <span class="muted t-sm truncate">{{ store.folderName() }}</span>
      <button
        type="button"
        class="btn btn-ghost btn-xs ml-auto"
        [title]="'files.filesPanel.readTheFolderAgain' | transloco"
        (click)="store.reload()"
      >
        {{ 'files.filesPanel.refresh' | transloco }}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-xs btn-square"
        [title]="'files.filesPanel.close' | transloco"
        [attr.aria-label]="'files.filesPanel.closeTheFilesPanel' | transloco"
        (click)="bus.closePanel()"
      >
        ✕
      </button>
    </div>
    <div class="px-3 py-2 flex items-center gap-2">
      <input
        #filter
        type="search"
        class="input input-sm flex-1 min-w-0"
        [placeholder]="'files.filesPanel.filterFiles' | transloco"
        [attr.aria-label]="'files.filesPanel.filterFiles' | transloco"
        [value]="store.query()"
        (input)="store.setQuery($any($event.target).value)"
        (keydown.escape)="clearFilter($event)"
        (keydown.arrowDown)="focusFirst($event)"
      />
      <label
        class="t-xs muted flex items-center gap-1 whitespace-nowrap"
        [title]="'files.filesPanel.listTheFilesGitIgnoresTooGreyed' | transloco"
        ><input
          type="checkbox"
          class="toggle toggle-xs"
          [checked]="store.showIgnored()"
          (change)="store.setShowIgnored($any($event.target).checked)"
        />
        {{ 'files.filesPanel.showIgnored' | transloco }}</label
      >
    </div>

    @if (coordination.others().length > 0) {
      <div class="pk-others" data-testid="others" [title]="'files.filesPanel.otherAgentsInThisFolderOrIn' | transloco">
        <span class="muted">{{ 'files.filesPanel.alsoWorkingHere' | transloco }}</span>
        @for (other of coordination.others(); track $index) {
          <span class="pk-agent" [attr.data-state]="other.state">{{ agentLabel(other) }}</span>
        }
      </div>
    }

    <div
      class="flex-1 overflow-y-auto px-2 pb-2"
      role="tree"
      tabindex="-1"
      [attr.aria-label]="'files.filesPanel.filesInTheFolder' | transloco"
      (keydown)="store.onKey($event)"
    >
      @if (!store.cwd()) {
        <p class="p-3 text-sm text-muted">{{ 'files.filesPanel.openAThreadToSeeItsFolder' | transloco }}</p>
      } @else if (store.error()) {
        <p class="p-3 text-sm text-error" role="alert">
          {{ 'files.filesPanel.theFolderCouldNotBeRead' | transloco: { value1: store.error() } }}
        </p>
      } @else if (store.query().trim()) {
        @for (row of store.rows(); track row.node.path) {
          <ng-container *ngTemplateOutlet="rowTpl; context: { $implicit: row.node, search: true }" />
        } @empty {
          <p class="p-3 text-sm text-muted">
            {{
              store.searching()
                ? ('files.filesPanel.searching' | transloco)
                : ('files.filesPanel.noFileMatches' | transloco) + store.query() + '”.'
            }}
          </p>
        }
      } @else {
        <ng-container *ngTemplateOutlet="level; context: { $implicit: '' }" />
        @if (store.loadingDirs().has('') && !store.children().has('')) {
          <div class="py-6 grid place-items-center">
            <span
              class="loading loading-dots loading-sm text-primary"
              [attr.aria-label]="'files.filesPanel.loadingFiles' | transloco"
            ></span>
          </div>
        }
      }
    </div>
    <div
      class="shrink-0 px-4 py-2 t-xs muted flex items-center gap-2"
      style="border-top: 1px solid var(--color-base-300)"
    >
      <span class="truncate">{{ 'files.filesPanel.dragAFileIntoTheMessageBox' | transloco }}</span>
      @if (store.changedCount() > 0) {
        <span class="ml-auto whitespace-nowrap">{{
          'files.filesPanel.changed' | transloco: { value1: store.changedCount() }
        }}</span>
      }
    </div>

    <ng-template #rowTpl let-node let-search="search">
      @let d = store.decoration()(node.path, node.dir);
      <div
        class="pk-node"
        role="treeitem"
        [attr.data-path]="node.path"
        [tabindex]="tabIndexOf(node.path)"
        draggable="true"
        [class.ignored]="node.ignored"
        [class.gone]="node.missing"
        [attr.aria-expanded]="node.dir ? store.expanded().has(node.path) : null"
        [attr.aria-selected]="store.selectedId() === node.path"
        (click)="store.onClick($event, node)"
        (keydown.enter)="store.enter(node, $event)"
        (dblclick)="!node.dir && store.open(node.path)"
        (contextmenu)="store.openMenu($event, node)"
        (focus)="store.setSelected(node.path)"
        (dragstart)="drag($event, node.path, node.dir)"
      >
        <span class="tw" aria-hidden="true">{{
          node.dir && !search ? (store.expanded().has(node.path) ? '▾' : '▸') : ''
        }}</span>
        <pk-file-icon [kind]="iconOf(node)" />
        <span class="nm" [class.font-medium]="node.dir" [title]="search ? node.path : node.name">{{
          search ? node.path : node.name
        }}</span>
        @if (d.thread) {
          <span class="pi" [title]="'files.filesPanel.changedByPiInThisThread' | transloco">π</span>
        }
        @if (!node.dir && coordination.leaseOf(node.path); as lease) {
          <span
            class="pk-lease"
            data-testid="lease-chip"
            [title]="leaseTitle(lease)"
            [attr.aria-label]="('files.filesPanel.beingEditedBy' | transloco) + lease.title"
          >
            <pk-icon name="pencil-small" />
            <span class="by">{{ 'files.filesPanel.beingEditedByeaedd' | transloco }}</span>
            <b>{{ lease.title }}</b>
          </span>
        }
        @if (node.dir && d.dot; as dot) {
          <span class="dot" [class]="dotClass(dot)" [title]="'files.filesPanel.changesInside' | transloco"></span>
        }
        @if (d.badge; as badge) {
          <span
            class="bdg"
            [class]="badgeClass(d)"
            [title]="
              d.badgeLabel +
              (d.staged ? ('files.filesPanel.staged' | transloco) : '') +
              (d.from ? ('files.filesPanel.from' | transloco) + d.from : '')
            "
            >{{ badge }}</span
          >
        }
        <span class="sz">{{ size(node) }}</span>
        <span class="mt">{{ time(node) }}</span>
        @if (!node.dir) {
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square act"
            [title]="'files.filesPanel.openInEditor' | transloco"
            [attr.aria-label]="'files.filesPanel.openInEditor' | transloco"
            tabindex="-1"
            (click)="store.open(node.path); $event.stopPropagation()"
          >
            ↗
          </button>
        } @else {
          <span class="act-spacer"></span>
        }
      </div>
    </ng-template>

    <ng-template #level let-dir>
      @for (node of store.children().get(dir) ?? []; track node.path) {
        <ng-container *ngTemplateOutlet="rowTpl; context: { $implicit: node, search: false }" />
        @if (node.dir && store.expanded().has(node.path)) {
          <div class="pk-nest" role="group">
            <ng-container *ngTemplateOutlet="level; context: { $implicit: node.path }" />
            @if (store.loadingDirs().has(node.path) && !store.children().has(node.path)) {
              <div class="pk-node">
                <span class="tw"></span><span class="nm muted">{{ 'files.filesPanel.loading' | transloco }}</span>
              </div>
            }
          </div>
        }
      }
    </ng-template>

    @if (store.menu(); as m) {
      <pk-context-menu
        [items]="m.items"
        [x]="m.x"
        [y]="m.y"
        [label]="'files.filesPanel.fileActions' | transloco"
        (chosen)="store.chooseMenu($event)"
        (dismissed)="store.closeMenu()"
      />
    }

    @if (store.confirm(); as c) {
      <dialog
        class="modal modal-open"
        aria-labelledby="files-confirm-title"
        tabindex="-1"
        (keydown.escape)="store.cancelConfirm()"
      >
        <div class="modal-box">
          <h3 id="files-confirm-title" class="t-xl">
            {{
              c.kind === 'delete' ? ('files.filesPanel.delete' | transloco) : ('files.filesPanel.revert' | transloco)
            }}
            {{ c.node.name }}?
          </h3>
          <p class="py-3 text-sm">
            <code class="break-all">{{ c.node.path }}</code>
            @if (c.kind === 'delete') {
              {{
                'files.filesPanel.isRemovedFromTheDiskItCannot'
                  | transloco
                    : {
                        value1: c.node.dir ? ('files.filesPanel.andEverythingInIt' | transloco) : '',
                        value2: c.deco.badge || c.node.dir ? '' : ('files.filesPanel.unlessGitHasTheFile' | transloco),
                      }
              }}
            } @else {
              {{ 'files.filesPanel.thisOverwritesTheFileOnDiskAnd' | transloco: { value1: revertText(c.deco.badge) } }}
            }
          </p>
          <div class="modal-action">
            <button type="button" class="btn btn-ghost btn-sm" (click)="store.cancelConfirm()">
              {{ 'files.filesPanel.cancel' | transloco }}
            </button>
            <button type="button" class="btn btn-error btn-sm" (click)="store.confirmed()">
              {{
                c.kind === 'delete'
                  ? ('files.filesPanel.delete' | transloco)
                  : ('files.filesPanel.revertFile' | transloco)
              }}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="button" (click)="store.cancelConfirm()">{{ 'files.filesPanel.closeda388' | transloco }}</button>
        </form>
      </dialog>
    }
  `,
})
export class FilesPanel {
  protected readonly i18n = inject(Language);
  protected readonly bus = inject(UiStore);
  protected readonly store = inject(FilesStore);
  protected readonly coordination = inject(CoordinationStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly filter = viewChild<ElementRef<HTMLInputElement>>('filter');

  constructor() {
    // The Files and Changes panels share one watcher; the store wants it while this panel is open.
    this.store.activate();
    // The chips of files another thread is editing.
    this.coordination.want('files', true);
    inject(DestroyRef).onDestroy(() => {
      this.store.deactivate();
      this.coordination.want('files', false);
    });

    // ⌘⇧F.
    let seenFilter = this.bus.filesFilter();
    effect(() => {
      const n = this.bus.filesFilter();
      if (n === seenFilter) return;
      seenFilter = n;
      queueMicrotask(() => {
        const input = this.filter()?.nativeElement;
        input?.focus();
        input?.select();
      });
    });

    // The store moves the selection (arrows, type-ahead, new and renamed files); the focus follows it.
    let seenFocus = this.store.focusRequests();
    effect(() => {
      const n = this.store.focusRequests();
      if (n === seenFocus) return;
      seenFocus = n;
      const path = untracked(() => this.store.selectedId());
      if (path)
        queueMicrotask(() => this.host.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus());
    });
  }

  // ---- template helpers

  protected iconOf(node: FileNode) {
    return fileIconKind(node.name, node.dir, this.store.expanded().has(node.path));
  }
  protected size(node: FileNode): string {
    return node.dir ? '' : formatSize(node.size);
  }
  protected time(node: FileNode): string {
    return formatMtime(this.i18n.t, node.mtime);
  }
  protected badgeClass(d: FileDecoration): string {
    return d.tone ? BADGE_CLASS[d.tone] : '';
  }
  protected dotClass(badge: GitBadge): string {
    return DOT_CLASS[DOT_TONE[badge]];
  }
  protected revertText = revertWords.bind(undefined, this.i18n.t);
  protected leaseTitle(lease: FileLease): string {
    const minutes = Math.max(0, Math.round((Date.now() - lease.at) / 60_000));
    return this.i18n.t('files.filesPanel.beingEditedByLastEditNothingStops', {
      value1: lease.title,
      value2:
        minutes < 1
          ? this.i18n.t('files.filesPanel.justNow')
          : this.i18n.t('files.filesPanel.minAgo', { value1: minutes }),
    });
  }
  protected agentLabel(other: OtherAgentInfo): string {
    return other.state === 'terminal'
      ? this.i18n.t('files.filesPanel.piInATerminal')
      : `${other.title}${other.state === 'running' ? this.i18n.t('files.filesPanel.running') : other.state === 'waiting' ? this.i18n.t('files.filesPanel.waiting') : ''}`;
  }
  protected tabIndexOf(path: string): number {
    const selected = this.store.selectedId();
    if (selected !== undefined) return selected === path ? 0 : -1;
    return this.store.rows()[0]?.node.path === path ? 0 : -1;
  }

  protected clearFilter(event: Event): void {
    if (this.store.clearFilter()) event.preventDefault();
  }

  protected focusFirst(event: Event): void {
    event.preventDefault();
    this.store.focusFirst();
  }

  protected drag(event: DragEvent, path: string, dir: boolean): void {
    const text = `@${path}${dir ? '/' : ''}`;
    event.dataTransfer?.setData(PATH_DRAG_TYPE, text);
    event.dataTransfer?.setData('text/plain', text);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  }
}
