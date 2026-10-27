import type { Translate } from '@pi-kit/i18n';
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
import {
  CONNECTOR_EXPOSURE_TEXT,
  CONNECTOR_EXPOSURES,
  type Connector,
  type ConnectorExposure,
  type McpCheckRequest,
  type McpCheckResult,
  connectorById,
} from '@pi-kit/protocol';
import { keepFocusInside, PkChoice, PkIcon, PkTip } from '@pi-kit/design-system';
import { ConnectorsStore, SecretsStore } from '@pi-kit/settings/api';
import { type ServerForm, addServer, blankForm, letters, validateForm } from '@pi-kit/settings/util';
import { ConnectorLogo } from './connector-logo';
import { PkServerForm } from './server-form';

/** What each way of reaching the model says in the select, short enough for one line; the long wording is the catalog's `CONNECTOR_EXPOSURE_TEXT.hint`. */
const exposureDescriptions = (translate: Translate): Record<ConnectorExposure, string> => ({
  direct: translate('settings.addServerWizard.everyToolIsInTheModelS'),
  deferred: translate('settings.addServerWizard.listedOnDemandSavesContext'),
  codemode: translate('settings.addServerWizard.calledFromCodeTheModelWrites'),
});

/**
 * The "+" of Settings › MCP servers: the catalog gallery (search, "For me / This project only", “Your own server” last), then
 * the details, with a reachability check before “Add and connect”. The steps are `addServer` (a pure step machine). A service from the catalog asks only for what its sign-in
 * needs (a token, the client id of your own app); a server of your own asks for a name, a URL or a command, and how its tools reach the model. The token and the client secret are
 * password fields with no reveal toggle, read from the element when the form is sent and emptied before the request leaves; this component keeps no copy (the Secrets rules of
 * doc/docs/design-system.md). A server of your own uses the full details form (`pk-server-form`): URL + headers or command + arguments + environment, and “As it will be written”;
 * it is written through `POST /api/mcp/servers`. Editing a server is the edit dialog's (`EditServerDialog`), not this wizard's.
 */
@Component({
  selector: 'pk-add-server-wizard',
  imports: [ConnectorLogo, PkChoice, PkServerForm, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf" data-testid="add-server-wizard">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.addServerWizard.close' | transloco"
        (click)="close()"
      ></button>
      <div
        #win
        class="win wide"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="title"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); close()"
      >
        <div class="head">
          <h2>{{ title }}</h2>
          <span
            class="dots"
            role="img"
            [attr.aria-label]="
              ('settings.addServerWizard.step' | transloco) +
              (state().step === 'gallery' ? 1 : 2) +
              ('settings.addServerWizard.of2' | transloco)
            "
          >
            <i class="on"></i><i [class.on]="state().step === 'details'"></i>
          </span>
          <button
            type="button"
            class="pk-close ml-auto"
            [pkTip]="'settings.addServerWizard.closeEsc' | transloco"
            [attr.aria-label]="'settings.addServerWizard.close' | transloco"
            (click)="close()"
          >
            <pk-icon name="close" />
          </button>
        </div>

        @switch (state().step) {
          @case ('gallery') {
            <div class="body">
              <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="gallery">
                <div class="flex items-center gap-3">
                  <input
                    type="search"
                    class="input input-sm flex-1"
                    [placeholder]="'settings.addServerWizard.searchServicesEGJiraSentryPostgres' | transloco"
                    [attr.aria-label]="'settings.addServerWizard.searchServices' | transloco"
                    autocomplete="off"
                    spellcheck="false"
                    data-testid="gallery-search"
                    [value]="state().query"
                    (input)="search($any($event.target).value)"
                  />
                  <select
                    class="select select-sm"
                    [attr.aria-label]="'settings.addServerWizard.whereItIsAdded' | transloco"
                    data-testid="gallery-scope"
                    (change)="setScope($any($event.target).value)"
                  >
                    <option value="user" [selected]="state().scope === 'user'">
                      {{ 'settings.addServerWizard.forMe' | transloco }}
                    </option>
                    <option value="project" [selected]="state().scope === 'project'" [disabled]="!hasThread()">
                      {{ 'settings.addServerWizard.thisProjectOnly' | transloco }}
                    </option>
                  </select>
                </div>
                <div
                  class="pk-choices pk-gallery"
                  role="group"
                  [attr.aria-label]="'settings.addServerWizard.services' | transloco"
                >
                  @for (c of services(); track c.id) {
                    <button pkChoice [attr.data-testid]="'tile-' + c.id" (click)="choose(c.id)">
                      <ng-container tile><pk-connector-logo [connector]="c" /></ng-container>
                      <ng-container t
                        >{{ c.name }}
                        @if (added(c.id)) {
                          <span class="chip ok">{{ 'settings.addServerWizard.added' | transloco }}</span>
                        }
                        @if (c.verification.status === 'unverified') {
                          <span class="chip warn" [pkTip]="c.verification.note">{{
                            'settings.addServerWizard.unverified' | transloco
                          }}</span>
                        }
                      </ng-container>
                      <ng-container d>{{ c.summary }}</ng-container>
                    </button>
                  }
                  @if (showsCustom()) {
                    <button pkChoice data-testid="tile-custom" (click)="choose('custom')">
                      <ng-container tile><pk-icon name="prompt" /></ng-container>
                      <ng-container t>{{ 'settings.addServerWizard.yourOwnServer' | transloco }}</ng-container>
                      <ng-container d>{{ 'settings.addServerWizard.aURLOrACommand' | transloco }}</ng-container>
                    </button>
                  }
                </div>
                @if (services().length === 0 && !showsCustom()) {
                  <p class="t-sm muted m-0">
                    {{
                      'settings.addServerWizard.noServiceMatchesYourOwnServerTakes'
                        | transloco: { value1: state().query }
                    }}
                  </p>
                }
                <div class="hint">
                  {{ 'settings.addServerWizard.catalogEntriesComeWithTheirSignIn' | transloco }}
                </div>
              </div>
            </div>
            <div class="foot">
              <span class="hint">{{ hint() }}</span>
              <button type="button" class="btn btn-sm btn-ghost ml-auto" (click)="close()">
                {{ 'settings.addServerWizard.cancel' | transloco }}
              </button>
            </div>
          }

          @case ('details') {
            <div class="body">
              <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="details">
                @if (connector(); as c) {
                  <div class="flex items-start gap-3" data-testid="details-service">
                    <span class="pk-tile"><pk-connector-logo [connector]="c" /></span>
                    <div>
                      <div class="lbl">{{ c.name }}</div>
                      <div class="hint">{{ c.summary }} {{ signInText(c) }}</div>
                    </div>
                  </div>
                }
                @if (!connector()) {
                  <pk-server-form
                    #customForm
                    [(form)]="custom"
                    mode="add"
                    [projectAllowed]="projectAllowed()"
                    [projectWhy]="projectWhy()"
                  />
                } @else {
                  <form class="pk-form" autocomplete="off" (submit)="submit($event)" data-testid="server-form">
                    @if (connector()?.auth?.type === 'bearer') {
                      <label for="srv-token">{{ 'settings.addServerWizard.token' | transloco }}</label>
                      <input
                        id="srv-token"
                        name="token"
                        type="password"
                        class="input input-sm mono"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        data-testid="connector-token"
                        (input)="touch()"
                      />
                      <div class="hint">{{ setupText() }} {{ whereTokenGoes() }}</div>
                    } @else if (connector()?.auth?.type === 'oauth-client') {
                      <label for="srv-client">{{ 'settings.addServerWizard.clientID' | transloco }}</label>
                      <input
                        id="srv-client"
                        name="clientId"
                        class="input input-sm mono"
                        autocomplete="off"
                        spellcheck="false"
                        data-testid="connector-client-id"
                        [value]="state().draft.clientId"
                        (input)="patch({ clientId: $any($event.target).value })"
                      />
                      <div class="hint">{{ setupText() }}</div>
                      <label for="srv-secret">{{ 'settings.addServerWizard.clientSecret' | transloco }}</label>
                      <input
                        id="srv-secret"
                        name="clientSecret"
                        type="password"
                        class="input input-sm mono"
                        [placeholder]="'settings.addServerWizard.ifYourAppHasOne' | transloco"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        data-testid="connector-client-secret"
                      />
                      <div class="hint">{{ whereTokenGoes() }}</div>
                    }
                    @if (connector()?.endpoint?.variants; as variants) {
                      <label for="srv-variant">{{ 'settings.addServerWizard.access' | transloco }}</label>
                      <select
                        id="srv-variant"
                        class="select select-sm"
                        data-testid="variant"
                        (change)="patch({ variant: $any($event.target).value })"
                      >
                        <option value="" [selected]="!state().draft.variant">
                          {{ 'settings.addServerWizard.full' | transloco }}
                        </option>
                        @for (v of variants; track v.id) {
                          <option [value]="v.id" [selected]="state().draft.variant === v.id">{{ v.label }}</option>
                        }
                      </select>
                    }
                    <label for="srv-exposure">{{ 'settings.addServerWizard.tools' | transloco }}</label>
                    <select
                      id="srv-exposure"
                      class="select select-sm"
                      data-testid="details-exposure"
                      (change)="patch({ exposure: $any($event.target).value })"
                    >
                      @for (e of exposures; track e) {
                        <option [value]="e" [selected]="state().draft.exposure === e">{{ exposureText(e) }}</option>
                      }
                    </select>
                    <label for="srv-scope">{{ 'settings.addServerWizard.scope' | transloco }}</label>
                    <select
                      id="srv-scope"
                      class="select select-sm"
                      data-testid="details-scope"
                      (change)="setScope($any($event.target).value)"
                    >
                      <option value="user" [selected]="state().scope === 'user'">
                        {{ 'settings.addServerWizard.forMeUserMcpJson' | transloco }}
                      </option>
                      <option value="project" [selected]="state().scope === 'project'" [disabled]="!projectAllowed()">
                        {{ 'settings.addServerWizard.thisProjectPiMcpJson' | transloco }}
                      </option>
                    </select>
                    @if (!projectAllowed() && state().scope === 'user') {
                      <div class="hint">{{ projectWhy() }}</div>
                    }
                  </form>
                }

                @if (checking()) {
                  <div class="box" role="status">
                    <div class="ok-line">
                      <span class="loading loading-spinner loading-xs"></span>
                      {{ 'settings.addServerWizard.askingTheServer' | transloco }}
                    </div>
                  </div>
                } @else if (check(); as result) {
                  <div class="box" role="status" data-testid="check-result" [attr.data-status]="result.status">
                    <div class="ok-line">
                      <span class="chip" [class]="result.ok ? 'ok' : 'err'">{{ checkLabel(result) }}</span>
                      <span>{{ result.message }}</span>
                    </div>
                  </div>
                }
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
                          {{ 'settings.addServerWizard.trustThisFolder' | transloco }}
                        </button>
                      }
                    </div>
                  }
                }
              </div>
            </div>
            <div class="foot">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-testid="wizard-back"
                [disabled]="busy()"
                (click)="back()"
              >
                {{ 'settings.addServerWizard.back' | transloco }}
              </button>
              <span class="hint">{{ hint() }}</span>
              <span class="ml-auto flex items-center gap-2">
                <button type="button" class="btn btn-sm btn-ghost" (click)="close()">
                  {{ 'settings.addServerWizard.cancel' | transloco }}
                </button>
                @if (!connector()) {
                  <button
                    type="button"
                    class="btn btn-sm"
                    data-testid="check-server"
                    [disabled]="busy() || checking()"
                    (click)="runCheck()"
                  >
                    {{ 'settings.addServerWizard.check' | transloco }}
                  </button>
                }
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  data-testid="server-add"
                  [disabled]="busy() || checking()"
                  (click)="submit($event)"
                >
                  @if (busy()) {
                    <span class="loading loading-spinner loading-xs"></span>
                  }
                  {{ primary() }}
                </button>
              </span>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class AddServerWizard implements OnInit {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(ConnectorsStore);
  private readonly secrets = inject(SecretsStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly customForm = viewChild<PkServerForm>('customForm');
  readonly closed = output<void>();

  protected readonly exposures = CONNECTOR_EXPOSURES;
  protected readonly letters = letters;
  protected readonly state = signal<addServer.AddServerState>(addServer.startAddServer());
  /** The details form of a server of your own. */
  protected readonly custom = signal<ServerForm>(blankForm());
  protected readonly error = signal('');
  protected readonly check = signal<McpCheckResult | undefined>(undefined);
  protected readonly checking = signal(false);
  /** What the last check was about, so a form that changed since is checked again before it is sent. */
  private checked = '';

  protected readonly catalog = this.store.catalog;
  protected readonly hasThread = computed(() => this.store.threadId() !== undefined);
  protected readonly services = computed(() => addServer.filterCatalog(this.catalog(), this.state().query));
  protected readonly connector = computed<Connector | undefined>(() => {
    const choice = this.state().choice;
    return choice && choice !== addServer.CUSTOM ? connectorById(choice, this.catalog()) : undefined;
  });
  protected readonly busy = computed(() => this.store.busy().size > 0);
  protected get title() {
    return this.i18n.t('settings.addServerWizard.addAServer');
  }
  protected readonly hint = computed(() => addServer.footHint.bind(undefined, this.i18n.t)(this.state()));
  protected readonly primary = computed(() => {
    const failed = this.check() && !this.check()?.ok;
    return failed
      ? this.i18n.t('settings.addServerWizard.addAnyway')
      : addServer.primaryText.bind(undefined, this.i18n.t)(this.state(), this.catalog());
  });
  protected readonly projectAllowed = computed(() =>
    addServer.projectAllowed(this.state().choice, this.catalog(), this.hasThread()),
  );

  private readonly injector = inject(Injector);

  constructor() {
    void this.secrets.loadStatus();
    void this.store.loadCatalog();
    queueMicrotask(() => this.win()?.nativeElement.focus());
    // The primary button is disabled while it adds or checks and takes the focus with it; Escape must still find this dialog and not the Settings window behind it.
    effect(() => {
      this.busy();
      this.checking();
      this.state();
      untracked(() => keepFocusInside(this.injector, () => this.win()?.nativeElement));
    });
    // The wizard opens on the details of a catalog service that needs input; the catalog arrives a moment after the wizard when it was not loaded yet.
    effect(() => {
      const wizard = this.store.wizard();
      const catalog = this.catalog();
      untracked(() => {
        if (!wizard?.id || this.state().step !== 'gallery') return;
        if (catalog.connectors.length === 0 && wizard.id !== addServer.CUSTOM) return;
        this.state.set(this.initial());
        this.resetCustom();
      });
    });
  }

  ngOnInit(): void {
    this.state.set(this.initial());
    this.resetCustom();
  }

  /** Where the wizard starts: the gallery, or the details of a service that needs input. */
  private initial(): addServer.AddServerState {
    const wizard = this.store.wizard();
    if (wizard?.id) return addServer.startAt(wizard.id, this.catalog(), this.store.choiceOf(wizard.id).scope);
    return addServer.startAddServer('user');
  }

  private resetCustom(): void {
    this.custom.set({ ...blankForm(this.state().scope), scope: this.state().scope });
  }

  protected showsCustom(): boolean {
    return addServer.showsCustom(this.state().query);
  }
  protected added(id: string): boolean {
    return this.store.rows().some((r) => r.connector?.id === id);
  }
  protected search(query: string): void {
    this.state.update((s) => ({ ...s, query }));
  }
  protected setScope(scope: 'user' | 'project'): void {
    this.state.update((s) => ({ ...s, scope }));
  }
  protected choose(id: string): void {
    this.clearResult();
    this.state.set(addServer.chooseServer(this.state(), id, this.catalog()));
    this.resetCustom();
    queueMicrotask(() => this.win()?.nativeElement.querySelector<HTMLInputElement>('input:not([disabled])')?.focus());
  }
  protected back(): void {
    this.clearResult();
    this.customForm()?.clearSecrets();
    this.state.set(addServer.backToGallery(this.state()));
  }
  protected patch(patch: Partial<addServer.ServerDraft>): void {
    this.state.set(addServer.patchDraft(this.state(), patch));
    this.touch();
  }
  protected touch(): void {
    if (this.error()) this.error.set('');
  }
  private clearResult(): void {
    this.error.set('');
    this.check.set(undefined);
    this.checked = '';
  }

  protected exposureText(e: ConnectorExposure): string {
    return `${CONNECTOR_EXPOSURE_TEXT[e].label} — ${exposureDescriptions(this.i18n.t)[e]}`;
  }
  protected checkLabel(result: McpCheckResult): string {
    return {
      reachable: 'reachable',
      'needs-sign-in': this.i18n.t('settings.addServerWizard.asksForASignIn'),
      refused: this.i18n.t('settings.addServerWizard.tokenRefused'),
      unreachable: this.i18n.t('settings.addServerWizard.noAnswer'),
      found: 'found',
      missing: this.i18n.t('settings.addServerWizard.notFound'),
    }[result.status];
  }
  protected signInText(c: Connector): string {
    switch (c.auth.type) {
      case 'bearer':
        return this.i18n.t('settings.addServerWizard.needsATokenYouCreateAt', { value1: c.vendor });
      case 'oauth-client':
        return this.i18n.t('settings.addServerWizard.needsYourOwnAppAClientId', { value1: c.vendor });
      default:
        return this.i18n.t('settings.addServerWizard.signsInInYourBrowserOnceIt');
    }
  }
  protected setupText(): string {
    const auth = this.connector()?.auth;
    return auth && (auth.type === 'bearer' || auth.type === 'oauth-client') ? auth.setup : '';
  }
  protected projectWhy(): string {
    if (!this.hasThread()) return this.i18n.t('settings.addServerWizard.thisProjectOnlyNeedsAThreadOpen');
    return this.connector() ? this.i18n.t('settings.addServerWizard.aServerWithATokenOrA') : '';
  }
  protected whereTokenGoes(): string {
    const status = this.secrets.status();
    return status?.available
      ? this.i18n.t('settings.addServerWizard.itGoesIntoYourPiSMcp', { value1: status.label })
      : this.i18n.t('settings.addServerWizard.thereIsNoCredentialStoreOnThis');
  }

  /** The text of a secret field, which is emptied when `clear` says so (the request that uses it has left). */
  private secretField(name: string, clear: boolean): string | undefined {
    const input = this.win()?.nativeElement.querySelector<HTMLInputElement>(`[name="${name}"]`);
    const typed = input?.value.trim() ?? '';
    if (input && clear) input.value = '';
    return typed || undefined;
  }

  private checkRequest(): McpCheckRequest | undefined {
    const f = this.custom();
    if (f.kind === 'url') {
      const token = this.customForm()?.token();
      return f.url.trim() ? { url: f.url.trim(), ...(token ? { token } : {}) } : undefined;
    }
    return f.command.trim() ? { command: f.command.trim() } : undefined;
  }

  /** “Check”: does the URL answer, or is the command on the PATH. Nothing is written. */
  protected async runCheck(): Promise<boolean> {
    if (this.connector()) return true;
    const problem = validateForm(this.i18n.t, this.custom());
    if (problem && ['url', 'command'].includes(problem.field)) {
      this.error.set(problem.message);
      return false;
    }
    const request = this.checkRequest();
    if (!request) return false;
    this.checking.set(true);
    this.error.set('');
    const key = JSON.stringify([request.url, request.command]);
    const result = await this.store.check(request);
    this.checking.set(false);
    this.check.set(result);
    this.checked = key;
    return result.ok;
  }

  /** “Add and connect”: check, unless it was just checked, then write the entry and let pi do the rest. A failed check stops here once and offers “Add anyway”. */
  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.checking()) return;
    const state = this.state();
    if (!this.connector()) return this.submitCustom();
    const token = this.secretField('token', false);
    const problem = addServer.validateServer.bind(undefined, this.i18n.t)(state, this.catalog(), {
      token: !!token,
      clientId: !!state.draft.clientId.trim(),
    });
    if (problem) return void this.error.set(problem.message);
    // The secrets are read now and the fields emptied before the request leaves.
    const secrets = { token: this.secretField('token', true), clientSecret: this.secretField('clientSecret', true) };
    const request = addServer.connectRequest(state, this.catalog(), secrets);
    if (!request) return;
    await this.store.add(request);
  }

  private async submitCustom(): Promise<void> {
    const form = this.customForm();
    if (!form) return;
    const problem = validateForm(this.i18n.t, this.custom());
    if (problem) return void this.error.set(problem.message);
    const request = this.checkRequest();
    const key = JSON.stringify([request?.url, request?.command]);
    const alreadyFailed = this.check() && !this.check()?.ok && this.checked === key;
    if (!alreadyFailed) {
      if (this.checked !== key && !(await this.runCheck())) return;
      if (this.check() && !this.check()?.ok) return;
    }
    // The secrets are read now, go into the one request, and are dropped when it has left.
    const body = form.create();
    const ok = await this.store.addServer(body);
    form.clearSecrets();
    if (ok) this.closed.emit();
  }

  protected close(): void {
    this.customForm()?.clearSecrets();
    this.store.closeWizard();
    this.closed.emit();
  }
}
