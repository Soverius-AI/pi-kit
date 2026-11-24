import { Component, computed, inject, input, linkedSignal, output, resource } from '@angular/core';
import { disabled, form, FormField, maxLength } from '@angular/forms/signals';
import { EntryApiClient, errorMessage, projectFoldersList, unwrap, type ProjectFolders } from '@pi-kit/api';
import { PkFolderTree, PkIcon, type PkFolderNode } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';

/** A single host-owned directory level, rendered inside the room's existing dialog. */
@Component({
  selector: 'pk-room-folder-picker',
  imports: [FormField, PkFolderTree, PkIcon, TranslocoPipe],
  host: { 'data-testid': 'room-folder-picker' },
  template: `
    <form class="location" (submit)="go($event)">
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        data-testid="room-folder-home"
        [attr.aria-label]="'rooms.assistant.folderPicker.home' | transloco"
        (click)="browse('')"
      >
        <pk-icon name="file-folder" size="18" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        data-testid="room-folder-up"
        [attr.aria-label]="'rooms.assistant.folderPicker.up' | transloco"
        [disabled]="listing.isLoading() || !result()?.parent"
        (click)="up()"
      >
        <pk-icon name="arrow-up" size="18" />
      </button>
      <label class="path"
        ><span class="sr-only">{{ 'rooms.assistant.target' | transloco }}</span
        ><input
          [formField]="pathFields.path"
          data-testid="room-folder-picker-path"
          autocomplete="off"
          spellcheck="false"
      /></label>
      <button
        type="submit"
        class="btn btn-ghost btn-sm"
        data-testid="room-folder-go"
        [disabled]="listing.isLoading() || pathFields().invalid()"
      >
        {{ 'rooms.assistant.folderPicker.go' | transloco }}
      </button>
    </form>
    @if (result()) {
      <p class="current">
        <span>{{ 'rooms.assistant.folderPicker.current' | transloco }}</span>
        <code data-testid="room-folder-picker-target">{{ target() }}</code>
      </p>
    }
    <label class="hidden-toggle"
      ><input type="checkbox" [formField]="filterFields.hidden" data-testid="room-folder-hidden" />{{
        'rooms.assistant.folderPicker.hidden' | transloco
      }}</label
    >
    <div
      class="folders"
      [attr.aria-busy]="listing.isLoading()"
      [attr.aria-label]="'rooms.assistant.folderPicker.title' | transloco"
    >
      @if (listing.isLoading()) {
        <p role="status">{{ 'rooms.assistant.folderPicker.loading' | transloco }}</p>
      } @else if (listing.error(); as failure) {
        <p role="alert" class="text-error">{{ message(failure) }}</p>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-testid="room-folder-picker-retry"
          (click)="listing.reload()"
        >
          {{ 'rooms.agents.retry' | transloco }}
        </button>
      } @else {
        <pk-folder-tree
          [folders]="result()?.folders ?? []"
          [scope]="treeScope()"
          [showHidden]="filters().hidden"
          [disabled]="!canBrowseTree()"
          [label]="'rooms.assistant.folderPicker.title' | transloco"
          [emptyLabel]="'rooms.assistant.folderPicker.empty' | transloco"
          [loadingLabel]="'rooms.assistant.folderPicker.loading' | transloco"
          [errorLabel]="'rooms.assistant.folderPicker.loadFailed' | transloco"
          [(selected)]="highlighted"
          [loadChildren]="loadChildren"
          (navigated)="browse($event)"
        />
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .location {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .path {
      flex: 1;
      min-width: 0;
    }
    input:not([type='checkbox']) {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      padding: 8px;
      background: var(--color-base-100);
    }
    .current {
      margin: 12px 0;
      font-size: 12px;
      color: var(--pk-muted);
      overflow-wrap: anywhere;
    }
    .current code {
      display: block;
      font-size: 12px;
      color: var(--color-base-content);
      white-space: pre-wrap;
    }
    .hidden-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 10px 0;
      font-size: 12px;
    }
    .folders {
      max-height: 320px;
      min-height: 100px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    p {
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--pk-muted);
    }
    button:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    @media (max-width: 767px) {
      button {
        min-height: 44px;
      }
      .location {
        flex-wrap: wrap;
      }
      .path {
        flex-basis: calc(100% - 160px);
      }
    }
  `,
})
export class RoomFolderPicker {
  readonly owner = input('');
  readonly initialPath = input('');
  readonly contextKey = input('');
  readonly selected = output<string>();
  private readonly api = inject(EntryApiClient);
  private readonly language = inject(Language);
  private readonly directory = linkedSignal(() => {
    this.owner();
    this.contextKey();
    return this.initialPath();
  });
  protected readonly listing = resource({
    params: () =>
      this.owner() ? { owner: this.owner(), directory: this.directory(), context: this.contextKey() } : undefined,
    loader: ({ params, abortSignal }) => this.list(params.owner, params.directory, abortSignal),
  });
  protected readonly result = computed(() => (this.listing.hasValue() ? this.listing.value() : undefined));
  protected readonly address = linkedSignal(() => ({ path: this.result()?.directory ?? this.directory() }));
  protected readonly pathFields = form(this.address, (path) => {
    disabled(path, () => this.listing.isLoading());
    maxLength(path.path, 4096);
  });
  protected readonly filters = linkedSignal(() => {
    this.owner();
    return { hidden: false };
  });
  protected readonly filterFields = form(this.filters);
  protected readonly treeScope = computed(() =>
    JSON.stringify([this.owner(), this.contextKey(), this.result()?.directory ?? '']),
  );
  protected readonly highlighted = linkedSignal(() => {
    this.treeScope();
    return '';
  });
  protected readonly target = computed(() => this.highlighted() || this.result()?.directory || '');
  protected readonly canBrowseTree = computed(
    () => !this.listing.isLoading() && !this.listing.error() && this.address().path === this.result()?.directory,
  );
  protected readonly loadChildren = async (path: string, signal: AbortSignal): Promise<readonly PkFolderNode[]> => {
    const owner = this.owner();
    const context = this.contextKey();
    const result = await this.list(owner, path, signal);
    if (signal.aborted || owner !== this.owner() || context !== this.contextKey())
      throw new DOMException('Folder browsing cancelled.', 'AbortError');
    return result.folders;
  };
  private async list(owner: string, directory: string, signal: AbortSignal): Promise<ProjectFolders> {
    const result = await unwrap(
      projectFoldersList({ client: this.api.forOwner(owner), query: directory ? { directory } : {}, signal }),
    );
    if (result.instanceId !== owner) throw new Error(this.language.t('rooms.assistant.folderPicker.ownerMismatch'));
    return result;
  }
  readonly canSelect = computed(
    () =>
      !this.listing.isLoading() &&
      !this.listing.error() &&
      !!this.target() &&
      this.address().path === this.result()?.directory,
  );
  choose(): void {
    if (this.canSelect()) this.selected.emit(this.target());
  }
  protected browse(path: string): void {
    this.directory.set(path);
  }
  protected up(): void {
    const parent = this.result()?.parent;
    if (parent) this.browse(parent);
  }
  protected go(event: Event): void {
    event.preventDefault();
    if (!this.pathFields().invalid()) this.browse(this.address().path);
  }
  protected message(error: unknown): string {
    return errorMessage(error);
  }
}
