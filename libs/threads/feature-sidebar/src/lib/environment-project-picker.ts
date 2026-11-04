import { CdkTrapFocus } from '@angular/cdk/a11y';
import { Component, computed, inject, linkedSignal, resource, signal } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import { EnvironmentsStore } from '@pi-kit/data-access';
import { errorMessage, projectFoldersList, unwrap, workspacesAddWorkspace } from '@pi-kit/api';

/** One project choice owns the environment; there is no second, contradictory chat destination. */
@Component({
  selector: 'pk-environment-project-picker',
  host: { style: 'display: contents' },
  imports: [CdkTrapFocus, TranslocoPipe],
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
          <h2 id="environment-project-title">{{ 'environments.projects.title' | transloco }}</h2>
          <label class="field"
            >{{ 'environments.projects.environment' | transloco }}
            <select
              class="select select-bordered"
              [value]="owner()"
              (change)="owner.set($any($event.target).value)"
              [disabled]="busy()"
              data-testid="project-environment"
            >
              @for (group of environments.groups(); track group.instanceId) {
                <option [value]="group.instanceId">
                  {{ group.name }} · {{ group.instanceId.slice(0, 8) }}
                  @if (group.local) {
                    · {{ 'environments.projects.local' | transloco }}
                  }
                </option>
              }
            </select>
          </label>
          <p class="muted">{{ 'environments.projects.inherited' | transloco }}</p>
          @if (known(); as projects) {
            <div class="known">
              @for (project of projects; track project.cwd) {
                <button type="button" class="btn btn-ghost" [disabled]="busy()" (click)="choose(project.cwd, false)">
                  {{ project.name }} <span class="path">{{ project.cwd }}</span>
                </button>
              }
            </div>
          }
          <label class="field"
            >{{ 'environments.projects.folder' | transloco }}
            <input
              class="input input-bordered"
              [value]="folders.value()?.directory ?? typed()"
              (input)="typed.set($any($event.target).value)"
              (keydown.enter)="browse(typed())"
              [disabled]="busy()"
              autocomplete="off"
            />
          </label>
          <div class="actions">
            <button type="button" class="btn btn-sm" (click)="browse(typed())" [disabled]="busy() || !owner()">
              {{ 'environments.projects.browse' | transloco }}
            </button>
            @if (folders.value()?.parent; as parent) {
              <button type="button" class="btn btn-sm btn-ghost" (click)="browse(parent)">
                {{ 'environments.projects.up' | transloco }}
              </button>
            }
          </div>
          @if (folders.isLoading()) {
            <p role="status">{{ 'environments.projects.loading' | transloco }}</p>
          }
          @if (folders.error()) {
            <p role="alert">{{ 'environments.projects.unavailable' | transloco }}</p>
          }
          <div class="folders">
            @for (folder of folders.value()?.folders ?? []; track folder.path) {
              <button type="button" class="btn btn-ghost" (click)="browse(folder.path)" [disabled]="busy()">
                {{ folder.name }}
              </button>
            }
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
              [disabled]="busy() || !folders.value() || folders.isLoading()"
              (click)="choose(folders.value()!.directory, true)"
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
      gap: 1rem;
      max-height: min(85dvh, 48rem);
      overflow: auto;
    }
    h2 {
      font-size: 1.2rem;
      font-weight: 600;
    }
    .field {
      display: grid;
      gap: 0.4rem;
    }
    .select,
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
    .known,
    .folders {
      display: grid;
      max-height: 12rem;
      overflow: auto;
    }
    .known .btn {
      display: grid;
      text-align: start;
      justify-content: start;
      height: auto;
      padding: 0.6rem;
    }
    .path {
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
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
  protected readonly known = computed(
    () => this.environments.groups().find((group) => group.instanceId === this.owner())?.projects,
  );
  protected readonly folders = resource({
    params: () =>
      this.environments.picker() && this.owner() ? { owner: this.owner(), directory: this.directory() } : undefined,
    loader: async ({ params, abortSignal }) => {
      const result = await unwrap(
        projectFoldersList({
          client: this.environments.api.forOwner(params.owner),
          query: params.directory ? { directory: params.directory } : {},
          signal: abortSignal,
        }),
      );
      if (result.instanceId !== params.owner) throw new Error('Folder owner mismatch.');
      return result;
    },
  });
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
}
