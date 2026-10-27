import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  CONNECTOR_EXPOSURE_TEXT,
  CONNECTOR_EXPOSURES,
  type ConnectorExposure,
  type McpScope,
  checkMcpFile,
  countServers,
} from '@pi-kit/protocol';
import { ChatStore } from '@pi-kit/chat/api';
import { IS_MAC } from '@pi-kit/data-access';
import { PkIcon, PkItem, PkScrollArea, PkTabPanel, PkTabs, PkTip } from '@pi-kit/design-system';
import { ConnectorsStore, type EditorSource, FileEditorDialog, SettingsStore } from '@pi-kit/settings/api';
import { type McpRow, fileRows } from '@pi-kit/settings/util';
import { PkContextMenu, type PkMenuItem } from '@pi-kit/ui';
import { AddServerWizard } from './add-server-wizard';
import { ConnectorLogo } from './connector-logo';
import { EditServerDialog } from './edit-server-dialog';

const serverActions = (translate: Translate): Record<string, string> => ({
  reconnect: translate('settings.mcpSection.reconnect'),
  toggle: translate('settings.mcpSection.turnOff'),
  'sign-out': translate('settings.mcpSection.signOut'),
  remove: translate('settings.mcpSection.remove'),
});

/**
 * Settings › MCP servers (the connectors gallery merged into it): one list of every server pi has, from `~/.pi/agent/mcp.json` and the
 * folder’s `.pi/mcp.json` (the latter once pi trusts the folder). A service from the catalog shows its logo tile and name; a server of your own a glyph, its command or URL and the
 * file. Each row: the state chip (connected, sign in needed, off, error), the scope chip, the tool count, the Tools exposure select, the one text button its state asks for
 * (Sign in, Try again, Reconnect, Turn on), Edit and More (Reconnect, Turn off / on, Sign out, Remove). The amber “+” opens the “Add a server” wizard (a lazy chunk); “The files”
 * lists the two `mcp.json` files with Edit here (the editor dialog), Open in editor and Reveal. Edit opens the details form of the server (`EditServerDialog`). The sidebar’s
 * “N MCP servers”, `/mcp` and `/connect` open this section.
 */
@Component({
  selector: 'pk-mcp-section',
  imports: [
    AddServerWizard,
    ConnectorLogo,
    EditServerDialog,
    FileEditorDialog,
    PkContextMenu,
    PkItem,
    PkTip,
    PkTabs,
    PkTabPanel,
    PkScrollArea,
    TranslocoPipe,
    PkIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-mcp">
      @if (mcp.notice(); as notice) {
        @if (!notice.url && !mcp.wizard() && !mcp.edit()) {
          <div
            role="status"
            class="m-4 flex items-start gap-3 rounded-lg border px-3 py-2 text-sm"
            [class.border-base-300]="notice.level === 'info'"
            [class.bg-base-200]="notice.level === 'info'"
            [class.border-error]="notice.level === 'error'"
            data-testid="connector-notice"
          >
            <span class="min-w-0 flex-1 break-words py-1" [class.text-error]="notice.level === 'error'">{{
              notice.text
            }}</span>
            @if (notice.trust && notice.server) {
              <button
                type="button"
                class="btn btn-sm shrink-0"
                data-testid="trust-folder"
                (click)="mcp.trustFolder(notice.server)"
              >
                {{ 'settings.mcpSection.trustThisFolder' | transloco }}
              </button>
            }
            <button
              type="button"
              class="pk-close shrink-0"
              [pkTip]="'settings.mcpSection.dismiss' | transloco"
              [attr.aria-label]="'settings.mcpSection.dismiss' | transloco"
              (click)="mcp.dismissNotice()"
            >
              <pk-icon name="close" />
            </button>
          </div>
        }
      }
      @for (error of mcp.overview()?.errors ?? []; track $index) {
        <p class="text-sm text-error break-words px-4 pt-3 m-0">{{ error }}</p>
      }

      <pk-tabs [label]="'settings.mcpSection.mCPServers' | transloco" [(value)]="tab">
        @if (store.shows('mcp-servers', 'mcp-add', 'connector-exposure', 'connector-project-only')) {
          <pk-tab-panel value="servers" [label]="'settings.mcpSection.servers' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.mcpSection.mCPServers' | transloco"
              data-setting="mcp-servers"
            >
              <header>
                <div>
                  <h4>{{ 'settings.mcpSection.servers' | transloco }}</h4>
                  <p>{{ summary() }}</p>
                </div>
                <span class="chip store" [pkTip]="storeTip()">{{ 'settings.mcpSection.piMcpJson' | transloco }}</span>
                <span [pkTip]="reloadTip()">
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    data-testid="mcp-reload"
                    [disabled]="reloadDisabled()"
                    (click)="mcp.reload()"
                  >
                    @if (mcp.busy().has('*')) {
                      <span class="loading loading-spinner loading-xs"></span>
                    }
                    {{ 'settings.mcpSection.reload' | transloco }}
                  </button>
                </span>
                <button
                  type="button"
                  class="btn btn-sm btn-primary btn-square add"
                  [pkTip]="'settings.mcpSection.addAServer' | transloco"
                  [attr.aria-label]="'settings.mcpSection.addAServer' | transloco"
                  data-testid="add-server"
                  (click)="mcp.openWizard()"
                >
                  <pk-icon name="plus" size="16" />
                </button>
              </header>

              <!-- A notice with a sign-in link is shown by the row that waits for it, so it is not said twice. -->
              @if (mcp.loading() && !mcp.overview()) {
                <div class="py-8 grid place-items-center">
                  <span
                    class="loading loading-dots loading-sm text-primary"
                    [attr.aria-label]="'settings.mcpSection.loadingMCPServers' | transloco"
                  ></span>
                </div>
              } @else {
                <pk-scroll-area class="pk-scroll-area-flush" [label]="'settings.mcpSection.mCPServers' | transloco">
                  <div role="list">
                    @for (row of mcp.rows(); track row.name) {
                      <div
                        pkItem
                        role="listitem"
                        [dimmed]="row.state === 'off'"
                        [attr.data-server]="row.name"
                        [attr.data-state]="row.state"
                        [attr.data-testid]="'mcp-row-' + row.name"
                      >
                        <ng-container tile>
                          @if (row.connector; as connector) {
                            <pk-connector-logo [connector]="connector" />
                          } @else if (row.server.transport === 'stdio') {
                            <pk-icon name="prompt" />
                          } @else {
                            <pk-icon name="globe" />
                          }
                        </ng-container>
                        <ng-container nm>
                          {{ row.connector?.name ?? row.name }}
                          <span class="chip" [class]="row.chip.tone" [attr.data-testid]="'state-' + row.name">{{
                            row.chip.text
                          }}</span>
                          <span class="chip off">{{ row.scope }}</span>
                          @if (row.tools) {
                            <span class="cnt" [attr.data-testid]="'tools-count-' + row.name">{{ row.tools }}</span>
                          }
                          @if (row.apps > 0) {
                            <span
                              class="chip"
                              [pkTip]="'settings.mcpSection.toolsOfThisServerOpenAnInteractive' | transloco"
                              >{{ row.apps }}
                              {{
                                row.apps === 1
                                  ? ('settings.mcpSection.app' | transloco)
                                  : ('settings.mcpSection.apps' | transloco)
                              }}</span
                            >
                          }
                          @if (row.connector?.verification?.status === 'unverified') {
                            <span class="chip warn" [pkTip]="row.connector?.verification?.note ?? ''">{{
                              'settings.mcpSection.unverified' | transloco
                            }}</span>
                          }
                        </ng-container>
                        <ng-container ds>{{ row.detail }}</ng-container>
                        <ng-container act>
                          @if (busy(row)) {
                            <span
                              class="loading loading-spinner loading-xs"
                              [attr.aria-label]="'settings.mcpSection.working' | transloco"
                            ></span>
                          } @else {
                            @if (row.editable && row.state !== 'off') {
                              <select
                                class="select select-xs"
                                [pkTip]="'settings.mcpSection.howToolsReachTheModel' | transloco"
                                [attr.data-testid]="'exposure-' + row.name"
                                [attr.aria-label]="row.name + ('settings.mcpSection.toolExposure' | transloco)"
                                [disabled]="!hasThread() || busy(row)"
                                (change)="mcp.setExposure(row.name, $any($event.target).value)"
                              >
                                @for (e of exposures; track e) {
                                  <option [value]="e" [selected]="row.exposure === e">{{ exposureText(e) }}</option>
                                }
                              </select>
                            }
                            @switch (row.primary) {
                              @case ('sign-in') {
                                <button
                                  type="button"
                                  class="btn btn-sm btn-primary"
                                  [attr.data-testid]="'signin-' + row.name"
                                  (click)="mcp.login(row.name)"
                                >
                                  {{ row.primaryText }}
                                </button>
                              }
                              @case ('try-again') {
                                <button
                                  type="button"
                                  class="btn btn-sm btn-primary"
                                  [attr.data-testid]="'signin-' + row.name"
                                  (click)="mcp.login(row.name)"
                                >
                                  {{ row.primaryText }}
                                </button>
                              }
                              @case ('reconnect') {
                                <button
                                  type="button"
                                  class="btn btn-sm"
                                  [attr.data-testid]="'reconnect-' + row.name"
                                  (click)="mcp.reconnect(row.name)"
                                >
                                  {{ row.primaryText }}
                                </button>
                              }
                              @case ('turn-on') {
                                <button
                                  type="button"
                                  class="btn btn-sm btn-ghost"
                                  [attr.data-testid]="'turn-on-' + row.name"
                                  [disabled]="reloadDisabled()"
                                  (click)="mcp.setEnabled(row.name, true)"
                                >
                                  {{ row.primaryText }}
                                </button>
                              }
                            }
                            @if (row.editable) {
                              <button
                                type="button"
                                class="btn btn-sm btn-ghost btn-square"
                                [pkTip]="'settings.mcpSection.edit' | transloco"
                                [attr.aria-label]="('settings.mcpSection.edit16f01' | transloco) + row.name"
                                [attr.data-testid]="'edit-' + row.name"
                                (click)="mcp.openEdit(row.name, scopeOf(row))"
                              >
                                <pk-icon name="pencil" />
                              </button>
                              <button
                                type="button"
                                class="btn btn-sm btn-ghost btn-square"
                                [pkTip]="'settings.mcpSection.more' | transloco"
                                [attr.aria-label]="('settings.mcpSection.moreFor' | transloco) + row.name"
                                aria-haspopup="menu"
                                [attr.data-testid]="'more-' + row.name"
                                (click)="openMenu($event, row)"
                              >
                                <pk-icon name="more" />
                              </button>
                            }
                          }
                        </ng-container>

                        <div extra class="extra">
                          @if (row.server.signIn; as signIn) {
                            @if (signIn.phase === 'waiting') {
                              <div class="signin" role="status" [attr.data-testid]="'signin-panel-' + row.name">
                                <div>
                                  <strong class="font-medium">{{
                                    'settings.mcpSection.waitingForYourBrowser' | transloco
                                  }}</strong>
                                  {{
                                    'settings.mcpSection.approveThereThisPageUpdatesWhenYou'
                                      | transloco: { value1: row.connector?.name ?? row.name }
                                  }}
                                </div>
                                @if (signIn.url) {
                                  <div class="url">
                                    <a
                                      class="link link-hover"
                                      [href]="signIn.url"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      [attr.data-testid]="'signin-url-' + row.name"
                                      >{{ signIn.url }}</a
                                    >
                                    <button
                                      type="button"
                                      class="btn btn-sm shrink-0"
                                      [attr.data-testid]="'copy-url-' + row.name"
                                      (click)="copy(row.name, signIn.url)"
                                    >
                                      {{
                                        copied() === row.name
                                          ? ('settings.mcpSection.copied' | transloco)
                                          : ('settings.mcpSection.copyLink' | transloco)
                                      }}
                                    </button>
                                  </div>
                                }
                                <div class="flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    class="btn btn-sm btn-ghost"
                                    [attr.data-testid]="'cancel-signin-' + row.name"
                                    (click)="mcp.cancelSignIn(row.name)"
                                  >
                                    {{ 'settings.mcpSection.cancelSignIn' | transloco }}
                                  </button>
                                  <button
                                    type="button"
                                    class="btn btn-sm btn-ghost"
                                    (click)="pasting.set(pasting() === row.name ? '' : row.name)"
                                  >
                                    {{ 'settings.mcpSection.browserOnAnotherMachine' | transloco }}
                                  </button>
                                </div>
                                @if (pasting() === row.name) {
                                  <form
                                    class="flex flex-wrap items-center gap-2 pk-expand"
                                    (submit)="paste($event, row)"
                                  >
                                    <input
                                      type="text"
                                      class="input input-sm flex-1 min-w-48 mono"
                                      name="redirect"
                                      [placeholder]="'settings.mcpSection.pasteTheAddressTheBrowserEndedOn' | transloco"
                                      [attr.aria-label]="'settings.mcpSection.theRedirectURL' | transloco"
                                      autocomplete="off"
                                      spellcheck="false"
                                      [attr.data-testid]="'paste-' + row.name"
                                    />
                                    <button type="submit" class="btn btn-sm">
                                      {{ 'settings.mcpSection.finishSignIn' | transloco }}
                                    </button>
                                  </form>
                                }
                              </div>
                            } @else if (signIn.phase === 'cancelled') {
                              <div class="t-xs muted" role="status">
                                {{ 'settings.mcpSection.signInCancelled' | transloco }}
                              </div>
                            }
                          }
                          @if (row.state === 'error' && errorText(row); as text) {
                            <div class="err" role="alert" [attr.data-testid]="'error-' + row.name">{{ text }}</div>
                            @if (row.connector; as connector) {
                              <div class="t-xs muted">
                                <a
                                  class="link link-hover"
                                  [href]="connector.docs"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  >{{
                                    'settings.mcpSection.sDocumentation' | transloco: { value1: connector.vendor }
                                  }}</a
                                >
                              </div>
                            }
                          }
                          @if (row.server.toolList && row.server.toolList.length > 0) {
                            <button
                              type="button"
                              class="tools-toggle"
                              [attr.aria-expanded]="open() === row.name"
                              [attr.data-testid]="'toggle-tools-' + row.name"
                              (click)="open.set(open() === row.name ? '' : row.name)"
                            >
                              <pk-icon name="chevron-right-small" />
                              {{
                                open() === row.name
                                  ? ('settings.mcpSection.hideTools' | transloco)
                                  : ('settings.mcpSection.showTools' | transloco)
                              }}
                            </button>
                            @if (open() === row.name) {
                              <div class="tools pk-expand" [attr.data-testid]="'tools-' + row.name">
                                @for (tool of row.server.toolList; track tool.name) {
                                  <div class="tool">
                                    <span class="tnm"
                                      >{{ tool.name }}
                                      @if (tool.app) {
                                        <span
                                          class="chip ml-2"
                                          [pkTip]="'settings.mcpSection.opensAnMCPAppInTheTranscript' | transloco"
                                          >{{ 'settings.mcpSection.app' | transloco }}</span
                                        >
                                      }
                                    </span>
                                    <span class="tds" [pkTip]="tool.description ?? ''">{{ tool.description }}</span>
                                  </div>
                                }
                              </div>
                            }
                          }
                        </div>
                      </div>
                    } @empty {
                      <div class="empty" data-testid="mcp-empty">
                        <span>{{ 'settings.mcpSection.noMCPServersYetAddOneTo' | transloco }}</span>
                        <button type="button" class="btn btn-sm btn-primary" (click)="mcp.openWizard()">
                          {{ 'settings.mcpSection.addAServer' | transloco }}
                        </button>
                      </div>
                    }
                  </div>
                </pk-scroll-area>
              }
            </section>
            @if (!store.searching()) {
              <p class="t-xs muted break-all">
                {{
                  'settings.mcpSection.catalogEndpointsWereReadFromEachVendor'
                    | transloco: { value1: mcp.catalog().updated }
                }}
              </p>
            }
          </pk-tab-panel>
        }
        @if (store.shows('mcp-files')) {
          <pk-tab-panel value="configuration" [label]="'settings.sectionTabs.configuration' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.mcpSection.theFiles' | transloco"
              data-setting="mcp-files"
              data-testid="mcp-files"
            >
              <header>
                <div>
                  <h4>{{ 'settings.mcpSection.theFiles' | transloco }}</h4>
                  <p>
                    {{ 'settings.mcpSection.everythingAboveIsTheseTwoFilesOpen' | transloco: { value1: fileManager } }}
                  </p>
                </div>
              </header>
              @for (file of files(); track file.scope) {
                <div class="row" [attr.data-testid]="'file-' + file.scope">
                  <div class="min-w-0">
                    <div class="lbl">
                      <span class="mono break-all">{{ file.path }}</span> <span class="chip off">{{ file.scope }}</span>
                    </div>
                    <div class="hint">
                      {{ file.count }}
                      {{
                        file.count === 1
                          ? ('settings.mcpSection.server' | transloco)
                          : ('settings.mcpSection.servers642f0' | transloco)
                      }}
                      @if (file.scope === 'project') {
                        {{ 'settings.mcpSection.readBecauseTheFolderIsTrusted' | transloco }}
                      }
                    </div>
                  </div>
                  <div class="ctl ctl-w">
                    <button
                      type="button"
                      class="btn btn-sm"
                      [attr.data-testid]="'edit-file-' + file.scope"
                      (click)="mcp.openFileEditor(file.scope)"
                    >
                      {{ 'settings.mcpSection.editHere' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      [pkTip]="'settings.mcpSection.opensInYourDefaultEditor' | transloco"
                      [attr.data-testid]="'open-' + file.scope"
                      (click)="mcp.openFile(file.scope, 'open')"
                    >
                      {{ 'settings.mcpSection.openInEditor' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost btn-square"
                      [pkTip]="revealTip"
                      [attr.aria-label]="revealTip"
                      [attr.data-testid]="'reveal-' + file.scope"
                      (click)="mcp.openFile(file.scope, 'reveal')"
                    >
                      <pk-icon name="folder" size="16" />
                    </button>
                  </div>
                </div>
              }
            </section>
          </pk-tab-panel>
        }
      </pk-tabs>
    </div>

    @if (menu(); as m) {
      <pk-context-menu
        [items]="menuItems()"
        [x]="m.x"
        [y]="m.y"
        [label]="('settings.mcpSection.actionsFor' | transloco) + m.row.name"
        (chosen)="choose($event)"
        (dismissed)="menu.set(undefined)"
      />
    }

    @defer (when mcp.wizard() !== undefined; prefetch on idle) {
      @if (mcp.wizard()) {
        <pk-add-server-wizard />
      }
    }
    @defer (when mcp.edit() !== undefined; prefetch on idle) {
      @if (mcp.edit()) {
        <pk-edit-server-dialog />
      }
    }
    @defer (when mcp.fileEditor() !== undefined; prefetch on idle) {
      @if (fileSource(); as source) {
        <pk-file-editor-dialog [source]="source" (closed)="mcp.closeFileEditor()" />
      }
    }
  `,
})
export class McpSection {
  protected readonly i18n = inject(Language);
  protected readonly mcp = inject(ConnectorsStore);
  protected readonly store = inject(SettingsStore);
  private readonly session = inject(ChatStore);

  protected readonly exposures = CONNECTOR_EXPOSURES;
  protected readonly tab = signal('servers');
  protected readonly open = signal('');
  protected readonly copied = signal('');
  protected readonly pasting = signal('');
  protected readonly menu = signal<{ row: McpRow; x: number; y: number } | undefined>(undefined);
  private readonly isMac = inject(IS_MAC);
  protected get fileManager() {
    return this.isMac ? this.i18n.t('settings.mcpSection.finder') : this.i18n.t('settings.mcpSection.theFileManager');
  }
  protected get revealTip() {
    return this.isMac
      ? this.i18n.t('settings.mcpSection.revealInFinder')
      : this.i18n.t('settings.mcpSection.showInTheFileManager');
  }

  protected readonly hasThread = computed(() => this.mcp.threadId() !== undefined);
  /** Changing a server reloads the session, which pi cannot do under a running prompt. */
  protected readonly reloadDisabled = computed(
    () => !this.hasThread() || this.session.running() || this.mcp.busy().size > 0,
  );
  protected readonly reloadTip = computed(() =>
    this.session.running()
      ? this.i18n.t('settings.mcpSection.stopTheRunFirst')
      : this.hasThread()
        ? this.i18n.t('settings.mcpSection.reconnectEveryServerInTheOpenThread')
        : this.i18n.t('settings.mcpSection.openAThreadFirst'),
  );
  /** The storage chip's tip is the file it names. */
  protected readonly storeTip = computed(() => {
    const overview = this.mcp.overview();
    return this.i18n.t('settings.mcpSection.andTheFolderSPiMcpJson', {
      value1: overview?.userConfig ?? '~/.pi/agent/mcp.json',
    });
  });
  protected readonly files = computed(() => {
    const overview = this.mcp.overview();
    return overview ? fileRows(overview, this.mcp.servers()) : [];
  });
  protected readonly summary = computed(() => {
    const rows = this.mcp.rows();
    if (rows.length === 0) return this.i18n.t('settings.mcpSection.nothingIsConfiguredYet');
    const on = rows.filter((r) => r.state !== 'off').length;
    const waiting = rows.filter((r) => r.state === 'needs-signin' || r.state === 'error').length;
    return this.i18n.t('settings.mcpSection.onChangesApplyToOpenThreadsAfter', {
      value1: on,
      value2:
        on === 1 ? this.i18n.t('settings.mcpSection.server') : this.i18n.t('settings.mcpSection.serverNounPlural'),
      value3:
        waiting > 0
          ? this.i18n.t('settings.mcpSection.aLook', {
              value1: waiting,
              value2:
                waiting === 1 ? this.i18n.t('settings.mcpSection.needs') : this.i18n.t('settings.mcpSection.need'),
            })
          : '',
    });
  });
  protected readonly menuItems = computed<PkMenuItem[]>(() => {
    const row = this.menu()?.row;
    if (!row) return [];
    const s = row.server;
    const items: PkMenuItem[] = [];
    if (s.enabled && s.state !== 'connecting')
      items.push({ id: 'reconnect', label: serverActions(this.i18n.t)['reconnect'] });
    items.push({
      id: 'toggle',
      label: s.enabled ? this.i18n.t('settings.mcpSection.turnOff') : this.i18n.t('settings.mcpSection.turnOn'),
      disabled: this.reloadDisabled(),
    });
    if (s.enabled && s.oauth && s.state === 'connected')
      items.push({ id: 'sign-out', label: serverActions(this.i18n.t)['sign-out'] });
    items.push({ id: 'remove', label: serverActions(this.i18n.t)['remove'], danger: true, separatorBefore: true });
    return items;
  });

  constructor() {
    // Showing the section asks for fresh states and for the catalog the backend serves.
    effect(() => {
      untracked(() => {
        void this.mcp.refresh();
        void this.mcp.loadCatalog();
      });
    });
  }

  /** The file the editor dialog works on: its text, its check (the same one `PUT /api/mcp/file` makes), its save (then the servers are read again). */
  protected readonly fileSource = computed<EditorSource | undefined>(() => {
    const scope = this.mcp.fileEditor();
    if (!scope) return undefined;
    // The dialog reads the file once when it opens; the overview moving after a save must not hand it a new source.
    const overview = untracked(() => this.mcp.overview());
    const path = scope === 'user' ? overview?.userConfig : overview?.projectConfig;
    return {
      title: path ? this.shortPath(path) : scope === 'user' ? '~/.pi/agent/mcp.json' : '.pi/mcp.json',
      chips: [{ text: scope === 'user' ? 'user' : 'project', ...(scope === 'user' ? { tone: 'off' as const } : {}) }],
      language: 'json',
      load: () => this.mcp.file(scope),
      save: async (text, mtime) => {
        const saved = await this.mcp.saveFile(scope, text, mtime);
        return { text: saved.file.text, mtime: saved.file.mtime, ...(saved.message ? { message: saved.message } : {}) };
      },
      check: (text) => {
        const first = checkMcpFile(text, scope).problems[0];
        return first ? { line: first.line, message: first.message } : undefined;
      },
      valid: (text) => {
        const n = countServers(text);
        return this.i18n.t('settings.mcpSection.validSReloadsThem', {
          value1: n,
          value2:
            n === 1 ? this.i18n.t('settings.mcpSection.server') : this.i18n.t('settings.mcpSection.serverNounPlural'),
        });
      },
      saveLabel: this.i18n.t('settings.mcpSection.saveAndReload'),
      openExternally: () => void this.mcp.openFile(scope, 'open'),
    };
  });

  protected scopeOf(row: McpRow): McpScope {
    return row.server.scope === 'project' ? 'project' : 'user';
  }

  private shortPath(path: string): string {
    return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  }

  protected exposureText(e: ConnectorExposure): string {
    return CONNECTOR_EXPOSURE_TEXT[e].label;
  }

  protected busy(row: McpRow): boolean {
    return this.mcp.busy().has(row.name) || this.mcp.busy().has('*');
  }

  protected errorText(row: McpRow): string | undefined {
    return row.server.signIn?.phase === 'failed' ? (row.server.signIn.message ?? row.server.error) : row.server.error;
  }

  protected openMenu(event: MouseEvent, row: McpRow): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menu.set({ row, x: rect.left, y: rect.bottom + 4 });
  }

  protected choose(id: string): void {
    const row = this.menu()?.row;
    this.menu.set(undefined);
    if (!row) return;
    switch (id) {
      case 'reconnect':
        void this.mcp.reconnect(row.name);
        break;
      case 'toggle':
        void this.mcp.setEnabled(row.name, !row.server.enabled);
        break;
      case 'sign-out':
        void this.mcp.logout(row.name);
        break;
      case 'remove':
        void this.mcp.disconnect(row.name);
        break;
    }
  }

  protected async copy(name: string, url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(name);
      setTimeout(() => this.copied() === name && this.copied.set(''), 2000);
    } catch {
      // the link is selectable text too
    }
  }

  protected paste(event: Event, row: McpRow): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const input = form.elements.namedItem('redirect') as HTMLInputElement;
    const url = input.value.trim();
    if (!url) return;
    input.value = '';
    this.pasting.set('');
    void this.mcp.pasteSignIn(row.name, url);
  }
}
