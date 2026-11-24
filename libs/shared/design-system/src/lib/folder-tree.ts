import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  model,
  output,
} from '@angular/core';
import { PkFileIcon } from './file-icon';
import { PkIcon } from './icon';

/** A presentation node; listing and canonical ownership stay with the caller. */
export interface PkFolderNode {
  name: string;
  path: string;
}
interface FolderRow {
  folder: PkFolderNode;
  parent: string;
}

/** The expandable project-folder browser shared by Threads and Rooms. */
@Component({
  selector: 'pk-folder-tree',
  imports: [NgTemplateOutlet, PkFileIcon, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree" role="tree" [attr.aria-label]="label()" [attr.aria-disabled]="disabled()">
      <ng-container *ngTemplateOutlet="level; context: { $implicit: visible(folders()) }" />
      @if (!visible(folders()).length) {
        <p class="note">{{ emptyLabel() }}</p>
      }
    </div>
    <ng-template #level let-list>
      @for (folder of list; track folder.path) {
        @let open = expanded().has(folder.path);
        <div
          class="tree-item"
          role="treeitem"
          [attr.data-path]="folder.path"
          [attr.aria-label]="folder.name"
          [attr.aria-expanded]="open"
          [attr.aria-selected]="selected() === folder.path"
          [attr.aria-busy]="pending().has(folder.path)"
          [tabindex]="tabIndexOf(folder.path)"
          (focus)="select(folder.path)"
          (keydown)="onKey($event); $event.stopPropagation()"
          (click)="pick(folder); $event.stopPropagation()"
          (dblclick)="navigate(folder.path); $event.stopPropagation()"
        >
          <div class="pk-node">
            <pk-icon class="tw" name="chevron-right" size="14" [class.open]="open" />
            <pk-file-icon [kind]="open ? 'folder-open' : 'folder'" />
            <span class="nm" [title]="folder.path">{{ folder.name }}</span>
          </div>
          @if (open) {
            <div class="pk-nest" role="group">
              @if (children().get(folder.path); as nested) {
                <ng-container *ngTemplateOutlet="level; context: { $implicit: visible(nested) }" />
                @if (!visible(nested).length) {
                  <div class="pk-node">
                    <span class="tw"></span><span class="nm muted">{{ emptyLabel() }}</span>
                  </div>
                }
              } @else {
                <div class="pk-node">
                  <span class="tw"></span><span class="nm muted">{{ loadingLabel() }}</span>
                </div>
              }
            </div>
          }
          @if (failed().has(folder.path)) {
            <p class="note err" role="alert">{{ errorLabel() }}</p>
          }
        </div>
      }
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .tree {
      min-width: 0;
    }
    .pk-node {
      cursor: pointer;
    }
    .tw {
      transition: transform 120ms ease;
    }
    .tw.open {
      transform: rotate(90deg);
    }
    .pk-node:hover,
    .tree-item:focus-visible > .pk-node {
      background: var(--color-base-300);
    }
    .tree-item:focus-visible {
      outline: none;
    }
    .tree-item:focus-visible > .pk-node {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .tree-item[aria-selected='true'] > .pk-node {
      background: color-mix(in srgb, var(--color-primary) 22%, transparent);
    }
    [aria-disabled='true'] .pk-node {
      cursor: default;
      opacity: 0.65;
    }
    .note {
      padding: 0.5rem;
      margin: 0;
      color: var(--pk-muted);
      font-size: 0.85rem;
    }
    .muted {
      color: var(--pk-muted);
      font-size: 0.8rem;
    }
    .err {
      color: var(--color-error);
    }
  `,
})
export class PkFolderTree {
  readonly folders = input.required<readonly PkFolderNode[]>();
  readonly scope = input.required<string>();
  readonly label = input.required<string>();
  readonly emptyLabel = input.required<string>();
  readonly loadingLabel = input.required<string>();
  readonly errorLabel = input.required<string>();
  readonly showHidden = input(false);
  readonly disabled = input(false);
  readonly selected = model('');
  readonly loadChildren = input.required<(path: string, signal: AbortSignal) => Promise<readonly PkFolderNode[]>>();
  readonly navigated = output<string>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly generation = linkedSignal({ source: () => this.scope(), computation: () => ({}) });
  protected readonly children = linkedSignal<object, ReadonlyMap<string, readonly PkFolderNode[]>>({
    source: this.generation,
    computation: () => new Map(),
  });
  protected readonly expanded = linkedSignal<object, ReadonlySet<string>>({
    source: this.generation,
    computation: () => new Set(),
  });
  protected readonly failed = linkedSignal<object, ReadonlySet<string>>({
    source: this.generation,
    computation: () => new Set(),
  });
  protected readonly pending = linkedSignal<object, ReadonlySet<string>>({
    source: this.generation,
    computation: () => new Set(),
  });
  private readonly requests = new Map<string, { generation: object; abort: AbortController }>();
  private readonly rows = computed(() => this.rowsOf(this.visible(this.folders()), ''));

  constructor() {
    effect(() => {
      const generation = this.generation();
      for (const [path, request] of this.requests) {
        if (request.generation === generation) continue;
        request.abort.abort();
        this.requests.delete(path);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      for (const request of this.requests.values()) request.abort.abort();
      this.requests.clear();
    });
  }
  protected visible(folders: readonly PkFolderNode[]): readonly PkFolderNode[] {
    return this.showHidden() ? folders : folders.filter((folder) => !folder.name.startsWith('.'));
  }
  protected tabIndexOf(path: string): number {
    if (this.disabled()) return -1;
    const selected = this.selected();
    const current = this.rows().some((row) => row.folder.path === selected) ? selected : this.rows()[0]?.folder.path;
    return path === current ? 0 : -1;
  }
  protected select(path: string): void {
    if (!this.disabled()) this.selected.set(path);
  }
  protected pick(folder: PkFolderNode): void {
    if (this.disabled()) return;
    this.selected.set(folder.path);
    this.toggle(folder.path);
  }
  protected navigate(path: string): void {
    if (!this.disabled()) this.navigated.emit(path);
  }
  protected onKey(event: KeyboardEvent): void {
    if (this.disabled()) return;
    const rows = this.rows();
    const at = rows.findIndex((row) => row.folder.path === this.selected());
    const row = rows[at];
    const open = row && this.expanded().has(row.folder.path);
    const move = (index: number) => {
      const next = rows[index];
      if (!next) return;
      event.preventDefault();
      this.selected.set(next.folder.path);
      const generation = this.generation();
      afterNextRender(
        () => {
          if (this.generation() !== generation || this.disabled()) return;
          this.host.nativeElement
            .querySelector<HTMLElement>(`[role="treeitem"][data-path="${CSS.escape(next.folder.path)}"]`)
            ?.focus();
        },
        { injector: this.injector },
      );
    };
    switch (event.key) {
      case 'Enter':
      case ' ':
        if (row) {
          event.preventDefault();
          this.pick(row.folder);
        }
        return;
      case 'ArrowDown':
        return move(at + 1);
      case 'ArrowUp':
        return move(Math.max(0, at - 1));
      case 'Home':
        return move(0);
      case 'End':
        return move(rows.length - 1);
      case 'ArrowRight':
        if (!row) return;
        event.preventDefault();
        if (!open) this.toggle(row.folder.path);
        else if (rows[at + 1]?.parent === row.folder.path) move(at + 1);
        return;
      case 'ArrowLeft':
        if (!row) return;
        event.preventDefault();
        if (open) this.toggle(row.folder.path);
        else if (row.parent) move(rows.findIndex((value) => value.folder.path === row.parent));
    }
  }
  private toggle(path: string): void {
    const expanded = new Set(this.expanded());
    if (expanded.delete(path)) return this.expanded.set(expanded);
    this.expanded.set(expanded.add(path));
    if (!this.children().has(path)) void this.fetchChildren(path);
  }
  private async fetchChildren(path: string): Promise<void> {
    const generation = this.generation();
    if (this.requests.get(path)?.generation === generation) return;
    const request = { generation, abort: new AbortController() };
    this.requests.set(path, request);
    this.pending.update((pending) => new Set(pending).add(path));
    this.failed.update((failed) => {
      const next = new Set(failed);
      next.delete(path);
      return next;
    });
    const current = () =>
      this.generation() === generation && this.requests.get(path) === request && !request.abort.signal.aborted;
    try {
      const result = await this.loadChildren()(path, request.abort.signal);
      if (current()) {
        const parents = new Map(this.rows().map((row) => [row.folder.path, row.parent]));
        const ancestors = new Set<string>();
        for (let ancestor = path; ancestor && !ancestors.has(ancestor); ancestor = parents.get(ancestor) ?? '')
          ancestors.add(ancestor);
        this.children.update((children) =>
          new Map(children).set(
            path,
            result.filter((folder) => !ancestors.has(folder.path)),
          ),
        );
      }
    } catch {
      if (current()) {
        this.expanded.update((expanded) => {
          const next = new Set(expanded);
          next.delete(path);
          return next;
        });
        this.failed.update((failed) => new Set(failed).add(path));
      }
    } finally {
      if (current()) {
        this.requests.delete(path);
        this.pending.update((pending) => {
          const next = new Set(pending);
          next.delete(path);
          return next;
        });
      }
    }
  }
  private rowsOf(folders: readonly PkFolderNode[], parent: string): FolderRow[] {
    return folders.flatMap((folder) => [
      { folder, parent },
      ...(this.expanded().has(folder.path)
        ? this.rowsOf(this.visible(this.children().get(folder.path) ?? []), folder.path)
        : []),
    ]);
  }
}
