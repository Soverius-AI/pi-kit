import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  type OnInit,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { errorMessage } from '@pi-kit/api';
import { keepFocusInside, PkIcon, PkTip } from '@pi-kit/design-system';
import type { McpServerDetail } from '@pi-kit/protocol';
import { ConnectorsStore } from '@pi-kit/settings/api';
import { type ServerForm, blankForm, loadForm, validateForm } from '@pi-kit/settings/util';
import { PkServerForm } from './server-form';

/**
 * Edit a server: the details form prefilled from the file that defines the server (`GET /api/mcp/servers/:name`), “As it will be
 * written”, **Remove server…** with a confirmation, and **Save and reconnect**, which writes the entry (a different name moves it) and reloads the thread's session. A stored secret
 * shows as stored and is kept unless something is typed over it; keys of the entry the form does not know stay in the file. The dialog closes when the save went through and stays open,
 * with pi-kit's message, when it did not.
 */
@Component({
  selector: 'pk-edit-server-dialog',
  imports: [PkServerForm, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf" data-testid="edit-server-dialog">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.editServerDialog.close' | transloco"
        (click)="close()"
      ></button>
      <div
        #win
        class="win wide"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="('settings.editServerDialog.edit' | transloco) + target().name"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); close()"
      >
        <div class="head">
          <h2>{{ target().name }}</h2>
          <span class="chip">{{
            target().scope === 'project'
              ? ('settings.editServerDialog.project' | transloco)
              : ('settings.editServerDialog.user' | transloco)
          }}</span>
          @if (detail(); as d) {
            <span class="muted t-sm mono min-w-0 truncate" [pkTip]="d.path">{{ d.path }}</span>
          }
          <button
            type="button"
            class="pk-close ml-auto"
            [pkTip]="'settings.editServerDialog.closeEsc' | transloco"
            [attr.aria-label]="'settings.editServerDialog.close' | transloco"
            (click)="close()"
          >
            <pk-icon name="close" />
          </button>
        </div>
        <div class="body">
          @if (loadError(); as text) {
            <p class="text-sm text-error break-words m-0" role="alert" data-testid="edit-load-error">{{ text }}</p>
          } @else if (!detail()) {
            <div class="py-8 grid place-items-center">
              <span
                class="loading loading-dots loading-sm text-primary"
                [attr.aria-label]="'settings.editServerDialog.readingTheServer' | transloco"
              ></span>
            </div>
          }
          <div class="wstep" [hidden]="!detail()" data-wstep="edit">
            <pk-server-form
              #formRef
              [(form)]="form"
              mode="edit"
              [kept]="detail()?.kept ?? []"
              [projectAllowed]="true"
            />
          </div>
          @if (error(); as text) {
            <div class="text-sm text-error break-words" role="alert" data-testid="server-error">{{ text }}</div>
          }
          @if (store.notice(); as notice) {
            @if (notice.level === 'error') {
              <div class="flex items-start gap-3 text-sm" role="alert" data-testid="server-notice">
                <span class="text-error break-words min-w-0 flex-1">{{ notice.text }}</span>
                @if (notice.trust) {
                  <button
                    type="button"
                    class="btn btn-sm shrink-0"
                    data-testid="trust-folder"
                    (click)="store.trustFolder(notice.server ?? '', false)"
                  >
                    {{ 'settings.editServerDialog.trustThisFolder' | transloco }}
                  </button>
                }
              </div>
            }
          }
        </div>
        <div class="foot">
          @if (confirming()) {
            <span class="text-sm" role="alert" data-testid="remove-confirm">{{
              'settings.editServerDialog.removeItsEntryLeavesTheFileAnd' | transloco: { value1: target().name }
            }}</span>
            <span class="ml-auto flex items-center gap-2">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-testid="remove-cancel"
                [disabled]="busy()"
                (click)="confirming.set(false)"
              >
                {{ 'settings.editServerDialog.keepIt' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-error"
                data-testid="remove-confirm-yes"
                [disabled]="busy()"
                (click)="remove()"
              >
                @if (busy()) {
                  <span class="loading loading-spinner loading-xs"></span>
                }
                {{ 'settings.editServerDialog.remove' | transloco }}
              </button>
            </span>
          } @else {
            <button
              type="button"
              class="btn btn-sm btn-ghost text-error"
              data-testid="remove-server"
              [disabled]="!detail() || busy()"
              (click)="confirming.set(true)"
            >
              {{ 'settings.editServerDialog.removeServer' | transloco }}
            </button>
            <span class="ml-auto flex items-center gap-2">
              <button type="button" class="btn btn-sm btn-ghost" (click)="close()">
                {{ 'settings.editServerDialog.cancel' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-testid="server-save"
                [disabled]="!detail() || busy()"
                (click)="save()"
              >
                @if (busy()) {
                  <span class="loading loading-spinner loading-xs"></span>
                }
                {{ 'settings.editServerDialog.saveAndReconnect' | transloco }}
              </button>
            </span>
          }
        </div>
      </div>
    </div>
  `,
})
export class EditServerDialog implements OnInit {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(ConnectorsStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly formRef = viewChild<PkServerForm>('formRef');
  readonly closed = output<void>();

  protected readonly form = signal<ServerForm>(blankForm());
  protected readonly detail = signal<McpServerDetail | undefined>(undefined);
  protected readonly loadError = signal('');
  protected readonly error = signal('');
  protected readonly confirming = signal(false);
  protected readonly target = computed(() => this.store.edit() ?? { name: '', scope: 'user' as const });
  protected readonly busy = computed(() => this.store.busy().size > 0);

  private readonly injector = inject(Injector);

  constructor() {
    // The foot's buttons are disabled while it saves and replaced by the confirmation of a removal; they take the focus with them, and Escape must still find this dialog.
    effect(() => {
      this.busy();
      this.confirming();
      this.detail();
      untracked(() => keepFocusInside(this.injector, () => this.win()?.nativeElement));
    });
  }

  ngOnInit(): void {
    queueMicrotask(() => this.win()?.nativeElement.focus());
    void this.load();
  }

  private async load(): Promise<void> {
    const { name, scope } = this.target();
    try {
      const detail = await this.store.serverDetail(name, scope);
      const loaded = loadForm(detail);
      this.detail.set(detail);
      // The form component is in the template from the start (hidden until the detail is there), so it can take the secrets of a literal that the file holds.
      queueMicrotask(() => this.formRef()?.load(loaded.form, loaded.secrets));
      this.form.set(loaded.form);
    } catch (error) {
      this.loadError.set(errorMessage(error));
    }
  }

  protected async save(): Promise<void> {
    const form = this.formRef();
    const detail = this.detail();
    if (!form || !detail || this.busy()) return;
    const problem = validateForm(this.i18n.t, this.form());
    if (problem) return void this.error.set(problem.message);
    this.error.set('');
    // The secrets are read now, go into the one request, and are dropped when it has left.
    const body = form.body();
    const ok = await this.store.saveServer(detail.name, detail.scope, body);
    form.clearSecrets();
    if (ok) this.closed.emit();
  }

  protected async remove(): Promise<void> {
    const detail = this.detail();
    if (!detail || this.busy()) return;
    const ok = await this.store.disconnect(detail.name);
    if (ok) {
      this.store.closeEdit();
      this.closed.emit();
    } else this.confirming.set(false);
  }

  protected close(): void {
    this.formRef()?.clearSecrets();
    this.store.closeEdit();
    this.closed.emit();
  }
}
