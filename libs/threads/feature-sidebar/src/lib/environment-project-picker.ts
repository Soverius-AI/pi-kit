import { CdkTrapFocus } from '@angular/cdk/a11y';
import { Component, computed, inject, linkedSignal, resource, signal } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import { EnvironmentsStore } from '@pi-kit/data-access';
import { PkFileIcon, PkFolderTree, PkIcon, type PkFolderNode } from '@pi-kit/design-system';
import { errorMessage, projectFoldersList, unwrap, workspacesAddWorkspace } from '@pi-kit/api';

/** One project choice owns the environment; there is no second, contradictory chat destination. */
@Component({
  selector: 'pk-environment-project-picker',
  host: { style: 'display: contents' },
  imports: [CdkTrapFocus, PkFileIcon, PkFolderTree, PkIcon, TranslocoPipe],
  template: `
    @if (environments.picker()) {
      <dialog
        open
        class="modal modal-open"
        aria-labelledby="environment-project-title"
        tabindex="-1"
        (keydown.escape)="close()"
      >
        <div class="modal-box" cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
          <header class="head">
            <h2 id="environment-project-title">{{ 'environments.projects.title' | transloco }}</h2>
            <select
              class="select select-sm select-bordered"
              [value]="owner()"
              (change)="owner.set($any($event.target).value)"
              [disabled]="busy()"
              [attr.aria-label]="'environments.projects.environment' | transloco"
              [title]="'environments.projects.inherited' | transloco"
              data-testid="project-environment"
            >
              @for (group of environments.groups(); track group.instanceId) {
                <option [value]="group.instanceId">
                  {{ group.name }}
                  @if (group.local) {
                    · {{ 'environments.projects.local' | transloco }}
                  }
                </option>
              }
            </select>
          </header>
          @if (known()?.length) {
            <div class="known">
              @for (project of known(); track project.cwd) {
                <button type="button" class="pk-node" [disabled]="busy()" (click)="choose(project.cwd, false)">
                  <pk-file-icon kind="folder" />
                  <span class="nm font-medium">{{ project.name }}</span>
                  <span class="path">{{ project.cwd }}</span>
                </button>
              }
            </div>
          }
          <div class="location">
            <button
              type="button"
              class="btn btn-ghost btn-sm btn-square"
              [disabled]="busy() || !folders.value()?.parent"
              [title]="'environments.projects.up' | transloco"
              [attr.aria-label]="'environments.projects.up' | transloco"
              (click)="browse(folders.value()!.parent!)"
              data-testid="project-folder-up"
            >
              <pk-icon name="arrow-up" size="20" />
            </button>
            <input
              class="input input-bordered input-sm mono"
              [value]="folders.value()?.directory ?? typed()"
              (input)="typed.set($any($event.target).value)"
              (keydown.enter)="browse(typed())"
              [disabled]="busy()"
              [attr.aria-label]="'environments.projects.folder' | transloco"
              autocomplete="off"
              spellcheck="false"
              data-testid="project-folder-path"
            />
            <button
              type="button"
              class="btn btn-ghost btn-sm btn-square"
              [disabled]="busy() || !owner()"
              [title]="'environments.projects.go' | transloco"
              [attr.aria-label]="'environments.projects.go' | transloco"
              (click)="browse(typed())"
            >
              <pk-icon name="arrow-right" size="20" />
            </button>
          </div>
          <div class="browser">
            <div class="tree" [attr.aria-busy]="folders.isLoading()">
              @if (folders.isLoading()) {
                <p class="note" role="status">{{ 'environments.projects.loadingFolders' | transloco }}</p>
              } @else if (folders.error()) {
                <p class="note err" role="alert">{{ 'environments.projects.unavailable' | transloco }}</p>
              } @else {
                <pk-folder-tree
                  data-testid="project-folders"
                  [folders]="folders.value()?.folders ?? []"
                  [scope]="treeScope()"
                  [showHidden]="showHidden()"
                  [disabled]="busy()"
                  [label]="'environments.projects.folders' | transloco"
                  [emptyLabel]="'environments.projects.empty' | transloco"
                  [loadingLabel]="'environments.projects.loadingFolders' | transloco"
                  [errorLabel]="'environments.projects.unavailable' | transloco"
                  [loadChildren]="loadFolderChildren"
                  [(selected)]="selected"
                  (navigated)="browse($event)"
                />
              }
            </div>
            <div class="foot">
              <span class="target" [title]="target()" data-testid="project-target">{{
                'environments.projects.opens' | transloco: { path: target() }
              }}</span>
              <label class="hidden-toggle">
                <input
                  type="checkbox"
                  class="toggle toggle-xs"
                  [checked]="showHidden()"
                  (change)="showHidden.set($any($event.target).checked)"
                />
                {{ 'environments.projects.hidden' | transloco }}
              </label>
            </div>
          </div>
          @if (error()) {
            <p role="alert">{{ error() }}</p>
          }
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-ghost"
              data-testid="project-cancel"
              (click)="close()"
              [disabled]="busy()"
            >
              {{ 'environments.projects.cancel' | transloco }}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || !target() || folders.isLoading()"
              (click)="choose(target()!, true)"
              data-testid="project-open"
            >
              {{ 'environments.projects.open' | transloco }}
            </button>
          </div>
        </div>
      </dialog>
    }
  `,
  styles: `
    .modal-box {
      display: grid;
      gap: 0.75rem;
      max-height: min(85dvh, 48rem);
      overflow: auto;
    }
    h2 {
      font-size: 1.2rem;
      font-weight: 600;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
    }
    .head .select {
      width: auto;
      max-width: 100%;
    }
    .input {
      width: 100%;
      min-width: 0;
      font-size: 16px;
    }
    .muted,
    .path {
      color: var(--pk-muted);
      font-size: 0.8rem;
    }
    .known {
      display: grid;
      max-height: 9rem;
      overflow: auto;
    }
    .known .pk-node {
      width: 100%;
      min-width: 0;
      gap: 6px;
      text-align: start;
      cursor: pointer;
    }
    .known .nm {
      flex: none;
      max-width: 50%;
    }
    .known .path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .location {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .location .input {
      flex: 1;
    }
    .browser {
      display: grid;
      gap: 0.4rem;
    }
    .tree {
      height: min(22rem, 50dvh);
      overflow: auto;
      padding: 4px;
      border: 1px solid var(--color-base-300);
      border-radius: var(--radius-field, 0.5rem);
      background: var(--color-base-200);
    }
    .note {
      padding: 0.75rem;
      color: var(--pk-muted);
      font-size: 0.85rem;
    }
    .foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 1rem;
    }
    .hidden-toggle {
      display: flex;
      flex: none;
      align-items: center;
      gap: 0.4rem;
      color: var(--pk-muted);
      font-size: 0.8rem;
    }
    .modal-action {
      align-items: center;
      margin-top: 0;
    }
    .target {
      flex: 1 1 12rem;
      min-width: 0;
      color: var(--pk-muted);
      font-size: 0.8rem;
      word-break: break-all;
    }
    [role='alert'] {
      color: var(--color-error);
    }
  `,
})
export class EnvironmentProjectPicker {
  protected readonly environments = inject(EnvironmentsStore);
  protected readonly owner = linkedSignal(
    () => this.environments.picker()?.initialOwner ?? this.environments.manager()?.self.instanceId ?? '',
  );
  protected readonly directory = linkedSignal(() => {
    this.owner();
    this.environments.picker();
    return '';
  });
  protected readonly typed = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly showHidden = signal(false);
  protected readonly known = computed(
    () => this.environments.groups().find((group) => group.instanceId === this.owner())?.projects,
  );
  protected readonly folders = resource({
    params: () =>
      this.environments.picker() && this.owner() ? { owner: this.owner(), directory: this.directory() } : undefined,
    loader: async ({ params, abortSignal }) => this.list(params.owner, params.directory, abortSignal),
  });
  protected readonly selected = linkedSignal<unknown, string>({
    source: () => this.folders.value(),
    computation: () => '',
  });
  protected readonly treeScope = computed(() => JSON.stringify([this.owner(), this.folders.value()?.directory ?? '']));
  protected readonly loadFolderChildren = async (path: string, signal: AbortSignal): Promise<readonly PkFolderNode[]> =>
    (await this.list(this.owner(), path, signal)).folders;
  protected readonly target = computed(() => this.selected() || this.folders.value()?.directory || '');

  protected browse(path: string): void {
    this.typed.set(path);
    this.directory.set(path);
    this.error.set('');
  }
  protected close(): void {
    if (!this.busy()) this.environments.picker.set(undefined);
  }
  protected async choose(cwd: string, add: boolean): Promise<void> {
    const request = this.environments.picker(),
      instanceId = this.owner();
    if (!request || !instanceId || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      if (add)
        await unwrap(workspacesAddWorkspace({ client: this.environments.api.forOwner(instanceId), body: { cwd } }));
      await request.pick({ instanceId, cwd });
      if (this.environments.picker() === request) this.environments.picker.set(undefined);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  private async list(owner: string, directory: string, signal?: AbortSignal) {
    const result = await unwrap(
      projectFoldersList({
        client: this.environments.api.forOwner(owner),
        query: directory ? { directory } : {},
        signal,
      }),
    );
    if (result.instanceId !== owner) throw new Error('Folder owner mismatch.');
    return result;
  }
}
