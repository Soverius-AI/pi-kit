import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { COPILOT_INSPECTOR_AT_START, RedactionStore, UiStore, ViewPrefs } from '@pi-kit/data-access';
import { PkLogo, PkTip, PkTabs, PkTabPanel } from '@pi-kit/design-system';
import { type RedactionConfig, type UserRedactionPattern, compileUserPatterns } from '@pi-kit/protocol';
import { PkSetting } from '@pi-kit/settings/api';
import { SecretsStore, SettingsStore } from '@pi-kit/settings/data';
import { PkAdvanced } from './advanced-block';

function size(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} kB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Settings › Advanced: diagnostics (backend port, data folder, log files, the boot id, “Copy diagnostics”), the pi release
 * in use with “Use previous release”, and the folders pi remembers a trust answer for, with a revoke button each.
 */
@Component({
  selector: 'pk-advanced-section',
  imports: [PkAdvanced, PkLogo, PkSetting, PkTip, PkTabs, PkTabPanel, TranslocoPipe, CdkTrapFocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-advanced">
      <pk-tabs [label]="'shared.catalog.advanced' | transloco" [(value)]="tab">
        @if (store.shows('diagnostics')) {
          <pk-tab-panel value="diagnostics" [label]="'settings.advancedSection.diagnostics' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.advancedSection.diagnostics' | transloco"
              data-testid="diagnostics"
            >
              <header>
                <div>
                  <h4>{{ 'settings.advancedSection.diagnostics' | transloco }}</h4>
                  <p>{{ 'settings.advancedSection.whatABugReportNeedsToKnow' | transloco }}</p>
                </div>
                <span class="chip store" [pkTip]="'settings.advancedSection.readFromTheRunningBackend' | transloco">{{
                  'settings.advancedSection.piKit' | transloco
                }}</span>
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-sm"
                    data-testid="run-setup-again"
                    [pkTip]="'settings.advancedSection.runSetupAgainHint' | transloco"
                    (click)="ui.openOnboarding()"
                  >
                    {{ 'settings.advancedSection.runSetupAgain' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    data-testid="copy-diagnostics"
                    (click)="store.copyDiagnostics()"
                  >
                    {{ 'settings.advancedSection.copyDiagnostics' | transloco }}
                  </button>
                </div>
              </header>
              <div class="row" data-testid="about">
                <div class="flex items-center gap-3 min-w-0">
                  <pk-logo tone="gold" [size]="32" [wordmark]="true" />
                  <div class="hint">{{ 'settings.advancedSection.builtBySoveriusAIGmbHADesktop' | transloco }}</div>
                </div>
              </div>
              @if (store.diagnostics(); as d) {
                <div class="row stack">
                  <dl class="kv">
                    <dt>{{ 'settings.advancedSection.backend' | transloco }}</dt>
                    <dd>
                      <span class="mono" data-testid="backend-address">{{ d.backend.host }}:{{ d.backend.port }}</span>
                      {{
                        'settings.advancedSection.pid'
                          | transloco
                            : {
                                value1: d.backend.pid,
                                value2: d.backend.desktop
                                  ? ('settings.advancedSection.desktopApp' | transloco)
                                  : ('settings.advancedSection.browser' | transloco),
                                value3: d.backend.dev ? ('settings.advancedSection.development' | transloco) : '',
                              }
                      }}
                    </dd>
                    <dt>{{ 'settings.advancedSection.port' | transloco }}</dt>
                    <dd class="mono" data-testid="backend-port">{{ d.backend.port }}</dd>
                    <dt>{{ 'settings.advancedSection.bootId' | transloco }}</dt>
                    <dd class="mono break-all" data-testid="boot-id">{{ d.backend.bootId }}</dd>
                    <dt>{{ 'settings.advancedSection.started' | transloco }}</dt>
                    <dd>{{ started(d.backend.startedAt) }}</dd>
                    <dt>{{ 'settings.advancedSection.piKit' | transloco }}</dt>
                    <dd>
                      {{
                        'settings.advancedSection.node'
                          | transloco
                            : { value1: d.app.version, value2: d.app.node, value3: d.app.platform, value4: d.app.arch }
                      }}
                    </dd>
                    <dt>{{ 'settings.advancedSection.pi' | transloco }}</dt>
                    <dd>
                      {{ d.pi.version }} ({{ d.pi.source }}) · <span class="mono break-all">{{ d.pi.packageDir }}</span>
                    </dd>
                    <dt>{{ 'settings.advancedSection.agentFolder' | transloco }}</dt>
                    <dd class="mono break-all">{{ d.pi.agentDir }}</dd>
                    <dt>{{ 'settings.advancedSection.dataFolder' | transloco }}</dt>
                    <dd class="mono break-all" data-testid="data-dir">{{ d.paths.dataDir }}</dd>
                    <dt>{{ 'settings.advancedSection.database' | transloco }}</dt>
                    <dd class="mono break-all">{{ d.paths.database }}</dd>
                    <dt>{{ 'settings.advancedSection.logFolder' | transloco }}</dt>
                    <dd class="mono break-all">{{ d.paths.logDir }}</dd>
                  </dl>
                </div>
                <div class="row stack" data-testid="log-files">
                  <div class="min-w-0">
                    <div class="lbl">{{ 'settings.advancedSection.logFiles' | transloco }}</div>
                    @for (log of d.logs; track log.path) {
                      <div class="hint mono break-all">
                        {{ log.path }} <span class="muted">· {{ bytes(log.size) }} · {{ started(log.modified) }}</span>
                      </div>
                    } @empty {
                      <div class="hint">
                        {{ 'settings.advancedSection.nothingHasBeenLoggedToFilesYet' | transloco }}
                      </div>
                    }
                  </div>
                </div>
                @if (d.flags.length > 0) {
                  <div class="row stack">
                    <div class="min-w-0">
                      <div class="lbl">{{ 'settings.advancedSection.switchesSet' | transloco }}</div>
                      <div class="hint mono break-all">
                        @for (flag of d.flags; track flag.name) {
                          <span class="mr-3">{{ flag.name }}={{ flag.value }}</span>
                        }
                      </div>
                    </div>
                  </div>
                }
              } @else {
                <div class="row">
                  <div class="hint">{{ 'settings.advancedSection.readingTheDiagnostics' | transloco }}</div>
                </div>
              }
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('secret-store', 'database-encryption', 'disk-encryption')) {
          <pk-tab-panel value="security" [label]="'settings.sectionTabs.security' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.advancedSection.secretsAndDataAtRest' | transloco"
              data-testid="secrets-at-rest"
            >
              <header>
                <div>
                  <h4>{{ 'settings.advancedSection.secretsAndDataAtRest' | transloco }}</h4>
                  <p>
                    {{ 'settings.advancedSection.whereKeysLiveWhetherPiKitS' | transloco }}
                  </p>
                </div>
                <span
                  class="chip store"
                  [pkTip]="'settings.advancedSection.readFromTheRunningBackendTheRedaction' | transloco"
                  >{{ 'settings.advancedSection.piKit' | transloco }}</span
                >
              </header>

              @if (store.shows('secret-store')) {
                <div class="row" data-testid="secret-store">
                  <div class="min-w-0">
                    <div class="lbl">
                      {{ 'settings.advancedSection.credentialStore' | transloco }}
                      <span
                        class="chip"
                        [class]="
                          secrets.status()?.credentialsEnabled === false
                            ? ''
                            : secrets.status()?.available
                              ? 'ok'
                              : 'warn'
                        "
                        data-testid="store-chip"
                        >{{
                          secrets.status()?.available
                            ? secrets.status()?.label
                            : ((secrets.status()?.credentialsEnabled === false
                                ? 'settings.advancedSection.storageDisabled'
                                : 'settings.advancedSection.noneOnThisMachine'
                              ) | transloco)
                        }}</span
                      >
                    </div>
                    <div class="hint">
                      @if (secrets.status()?.available) {
                        {{ 'settings.advancedSection.newKeysCanBeStoredHereProvider' | transloco }}
                        <span class="mono">{{ secrets.status()?.resolver }}</span
                        >.
                      } @else if (secrets.status()?.credentialsEnabled === false) {
                        {{ 'settings.advancedSection.directStorageHint' | transloco }}
                      } @else {
                        {{ 'settings.advancedSection.newAPIKeysStayInPiS' | transloco }}
                      }
                    </div>
                    @if (secrets.status()?.access?.reason; as reason) {
                      <div class="hint" role="status" data-testid="credential-access">{{ reason }}</div>
                    }
                    @if (secrets.status()?.cliNeeded) {
                      <div class="hint">
                        {{ 'settings.advancedSection.thePiCommandLineRunsThatCommand' | transloco }}
                        <span class="mono">{{ 'settings.advancedSection.piKitSecret' | transloco }}</span>
                        {{ 'settings.advancedSection.mustBeOnPATHForItTo' | transloco }}
                      </div>
                    }
                    @if (secrets.installed(); as installed) {
                      <div class="hint" role="status" data-testid="cli-installed">
                        {{ 'settings.advancedSection.installedAt' | transloco }}
                        <span class="mono break-all">{{ installed.path }}</span
                        >.{{
                          installed.onPath ? '' : ('settings.advancedSection.thatFolderIsNotOnYourPATH' | transloco)
                        }}
                      </div>
                    }
                  </div>
                  <div class="ctl ctl-w">
                    <button
                      type="button"
                      class="btn btn-sm"
                      data-testid="credential-storage-toggle"
                      [disabled]="!secrets.status() || secrets.storageBusy()"
                      (click)="storageChoice.set(secrets.status()?.credentialsEnabled === false)"
                    >
                      {{
                        (secrets.status()?.credentialsEnabled === false
                          ? 'settings.advancedSection.enableCredentialStorage'
                          : 'settings.advancedSection.useDirectKeys'
                        ) | transloco
                      }}
                    </button>
                    @if (secrets.status()?.available && secrets.status()?.access?.reason) {
                      <button
                        type="button"
                        class="btn btn-sm"
                        [disabled]="secrets.retrying()"
                        (click)="secrets.retryAccess()"
                      >
                        {{ 'settings.advancedSection.retryCredentialAccess' | transloco }}
                      </button>
                    }
                    @if (secrets.status()?.credentialsEnabled !== false && secrets.status()?.cliInstallDir) {
                      @if (secrets.status()?.cliOnPath) {
                        <span class="chip ok" data-testid="cli-chip">{{
                          'settings.advancedSection.piKitSecretIsOnPATH' | transloco
                        }}</span>
                      } @else {
                        <button
                          type="button"
                          class="btn btn-sm"
                          data-testid="install-cli"
                          [disabled]="secrets.installing()"
                          [pkTip]="
                            ('settings.advancedSection.writesALauncherTo' | transloco) + secrets.status()?.cliInstallDir
                          "
                          (click)="secrets.installCli()"
                        >
                          {{ 'settings.advancedSection.installPiKitSecretOnPATH' | transloco }}
                        </button>
                      }
                    }
                  </div>
                </div>
              }

              @if (secrets.storageResult(); as result) {
                <div class="row" role="status" data-testid="credential-storage-result">
                  <div>
                    <p class="hint">
                      {{ 'settings.advancedSection.storageResult' | transloco: { count: result.moved.length } }}
                    </p>
                    @for (failure of result.failed; track $index) {
                      <p class="hint text-warning">
                        {{ failure.provider }} — {{ 'settings.advancedSection.storageUnreadable' | transloco }}
                      </p>
                    }
                  </div>
                </div>
              }

              @if (store.shows('database-encryption')) {
                <div class="row" data-testid="database-protection">
                  <div class="min-w-0">
                    <div class="lbl">
                      {{ 'settings.advancedSection.database' | transloco }}
                      <span
                        class="chip"
                        [class]="secrets.protection()?.database?.state === 'encrypted' ? 'ok' : 'warn'"
                        data-testid="database-chip"
                        >{{
                          secrets.protection()?.database?.state === 'encrypted'
                            ? ('settings.advancedSection.encrypted' | transloco)
                            : secrets.protection()
                              ? ('settings.advancedSection.notEncrypted' | transloco)
                              : ('settings.advancedSection.checking' | transloco)
                        }}</span
                      >
                    </div>
                    @if (secrets.protection(); as p) {
                      <div class="hint mono break-all">{{ p.database.path }}</div>
                      @if (p.database.state === 'encrypted') {
                        <div class="hint">
                          {{ 'settings.advancedSection.transcriptsToolOutputFileBaselinesAndThe' | transloco }}
                        </div>
                      } @else {
                        <div class="hint text-warning" data-testid="database-warning">
                          {{
                            'settings.advancedSection.anyoneWhoCanReadThisFileCan'
                              | transloco
                                : {
                                    value1:
                                      p.database.reason ??
                                      ('settings.advancedSection.theFileIsNotEncrypted' | transloco),
                                  }
                          }}
                        </div>
                      }
                    }
                  </div>
                  <div class="ctl ctl-w">
                    <button
                      type="button"
                      class="btn btn-sm"
                      data-testid="export-recovery-key"
                      [disabled]="
                        secrets.recoveryBusy() ||
                        secrets.protection()?.database?.state !== 'encrypted' ||
                        secrets.protection()?.database?.recoveryKeyShown
                      "
                      (click)="secrets.showRecoveryKey()"
                    >
                      {{
                        secrets.protection()?.database?.recoveryKeyShown
                          ? ('settings.advancedSection.recoveryKeyShown' | transloco)
                          : ('settings.advancedSection.exportRecoveryKey' | transloco)
                      }}
                    </button>
                  </div>
                </div>
              }

              @if (store.shows('disk-encryption')) {
                <div class="row" data-testid="disk-encryption">
                  <div class="min-w-0">
                    <div class="lbl">
                      {{ 'settings.advancedSection.diskEncryption' | transloco }}
                      <span class="chip" [class]="diskTone()" data-testid="disk-chip">{{
                        secrets.protection()?.disk
                          ? secrets.protection()?.disk?.mechanism + ' ' + secrets.protection()?.disk?.state
                          : ('settings.advancedSection.checking' | transloco)
                      }}</span>
                    </div>
                    <div class="hint">
                      {{
                        'settings.advancedSection.oAuthTokensSubscriptionsRadiusStayInFiles'
                          | transloco
                            : {
                                value1:
                                  secrets.protection()?.disk?.detail ??
                                  ('settings.advancedSection.askingTheOperatingSystem' | transloco),
                              }
                      }}
                    </div>
                  </div>
                </div>
              }
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('redaction')) {
          <pk-tab-panel value="privacy" [label]="'shared.catalog.privacy' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.advancedSection.redaction' | transloco"
              data-testid="redaction-settings"
            >
              <header>
                <div>
                  <h4>{{ 'settings.advancedSection.redaction' | transloco }}</h4>
                </div>
              </header>
              @if (store.shows('redaction')) {
                <div class="row" data-testid="redaction">
                  <div class="min-w-0">
                    <div class="lbl">{{ 'settings.advancedSection.redaction' | transloco }}</div>
                    <div class="hint">
                      {{ 'settings.advancedSection.keysInAPromptInToolOutput' | transloco }}
                      <span class="mono">{{ 'settings.advancedSection.redactedOpenaiKeyA1b2' | transloco }}</span>
                      {{ 'settings.advancedSection.andAreMaskedBeforeTheyAreWritten' | transloco }}
                    </div>
                  </div>
                </div>
                @for (workspace of store.workspaces(); track workspace.cwd) {
                  <div class="row" [attr.data-testid]="'redaction-folder-' + workspace.name">
                    <div class="min-w-0">
                      <div class="lbl" [id]="'lbl-redact-' + workspace.name">
                        {{ 'settings.advancedSection.maskKeysIn' | transloco }}
                        <b class="font-medium">{{ workspace.name }}</b>
                      </div>
                      <div class="hint mono break-all">{{ workspace.cwd }}</div>
                    </div>
                    <div class="ctl ctl-w">
                      <input
                        type="checkbox"
                        class="toggle toggle-primary"
                        role="switch"
                        [attr.aria-labelledby]="'lbl-redact-' + workspace.name"
                        [attr.data-testid]="'redact-' + workspace.name"
                        [checked]="redactionOn(workspace.cwd)"
                        (change)="setFolder(workspace.cwd, $any($event.target).checked)"
                      />
                    </div>
                  </div>
                }
                @for (pattern of redaction.config().patterns; track $index) {
                  <div class="row" data-testid="redaction-pattern">
                    <div class="min-w-0">
                      <div class="lbl">{{ pattern.name }}</div>
                      <div class="hint mono break-all">{{ pattern.regex }}</div>
                    </div>
                    <div class="ctl ctl-w">
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        [attr.aria-label]="('settings.advancedSection.removeThePattern' | transloco) + pattern.name"
                        (click)="removePattern($index)"
                      >
                        {{ 'settings.advancedSection.remove' | transloco }}
                      </button>
                    </div>
                  </div>
                }
                <form class="row" data-testid="redaction-patterns" (submit)="addPattern($event)">
                  <div class="min-w-0">
                    <div class="lbl">{{ 'settings.advancedSection.addAPatternOfYourOwn' | transloco }}</div>
                    <div class="hint">{{ 'settings.advancedSection.aNameAndARegularExpressionFor' | transloco }}</div>
                    @if (draftError(); as error) {
                      <div class="hint text-error" role="alert" data-testid="pattern-error">{{ error }}</div>
                    }
                    @for (error of redaction.errors(); track error) {
                      <div class="hint text-error" role="alert">{{ error }}</div>
                    }
                  </div>
                  <div class="ctl ctl-w flex-col items-stretch">
                    <label class="sr-only" for="pattern-name">{{
                      'settings.advancedSection.patternName' | transloco
                    }}</label>
                    <input
                      id="pattern-name"
                      name="name"
                      class="input input-sm"
                      [placeholder]="'settings.advancedSection.acmeToken' | transloco"
                      autocomplete="off"
                      spellcheck="false"
                      [value]="draftName()"
                      (input)="draftName.set($any($event.target).value)"
                    />
                    <label class="sr-only" for="pattern-regex">{{
                      'settings.advancedSection.regularExpression' | transloco
                    }}</label>
                    <input
                      id="pattern-regex"
                      name="regex"
                      class="input input-sm mono"
                      [placeholder]="'settings.advancedSection.acmeAZ0912' | transloco"
                      autocomplete="off"
                      spellcheck="false"
                      [value]="draftRegex()"
                      (input)="draftRegex.set($any($event.target).value)"
                    />
                    <button
                      type="submit"
                      class="btn btn-sm self-end"
                      data-testid="add-pattern"
                      [disabled]="!draftName().trim() || !draftRegex().trim()"
                    >
                      {{ 'settings.advancedSection.addPattern' | transloco }}
                    </button>
                  </div>
                </form>
              }
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('pi-release', 'copilot-inspector')) {
          <pk-tab-panel value="runtime" [label]="'settings.sectionTabs.runtime' | transloco">
            <div class="flex flex-col gap-5">
              @if (store.shows('pi-release')) {
                <pk-advanced />
              }

              @if (store.shows('copilot-inspector')) {
                <section
                  class="pk-group"
                  [attr.aria-label]="'settings.advancedSection.developerTools' | transloco"
                  data-testid="developer-tools"
                >
                  <header>
                    <div>
                      <h4>{{ 'settings.advancedSection.developerTools' | transloco }}</h4>
                      <p>{{ 'settings.advancedSection.forLookingInsidePiKitSChat' | transloco }}</p>
                    </div>
                  </header>
                  <div pkSetting="copilot-inspector">
                    @if (prefs.copilotInspector() !== inspectorAtStart) {
                      <button type="button" class="btn btn-sm" data-testid="inspector-reload" (click)="reload()">
                        {{ 'settings.advancedSection.reloadWindow' | transloco }}
                      </button>
                    }
                    <input
                      type="checkbox"
                      class="toggle toggle-primary"
                      aria-labelledby="lbl-copilot-inspector"
                      aria-describedby="hint-copilot-inspector"
                      data-testid="copilot-inspector"
                      [checked]="prefs.copilotInspector()"
                      (change)="store.setPref('copilotInspector', $any($event.target).checked)"
                    />
                  </div>
                </section>
              }
            </div>
          </pk-tab-panel>
        }
        @if (store.shows('trust-list')) {
          <pk-tab-panel value="trust" [label]="'shared.catalog.trust' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.advancedSection.savedTrustDecisions' | transloco"
              data-testid="trust-list"
            >
              <header>
                <div>
                  <h4>{{ 'settings.advancedSection.savedTrustDecisions' | transloco }}</h4>
                  <p>{{ 'settings.advancedSection.foldersPiRemembersAnAnswerForRevoking' | transloco }}</p>
                </div>
                <span class="chip store" [pkTip]="'settings.advancedSection.piSTrustJsonInItsAgent' | transloco">{{
                  'settings.advancedSection.piTrustJson' | transloco
                }}</span>
              </header>
              @for (entry of store.trustList()?.entries ?? []; track entry.path) {
                <div class="row" [attr.data-testid]="'trust-' + entry.path">
                  <div class="min-w-0">
                    <div class="lbl">
                      <span class="mono break-all">{{ entry.path }}</span>
                      <span class="chip" [class]="entry.decision ? 'ok' : 'err'">{{
                        entry.decision
                          ? ('settings.advancedSection.trusted' | transloco)
                          : ('settings.advancedSection.neverTrust' | transloco)
                      }}</span>
                      @if (!entry.exists) {
                        <span class="chip warn">{{ 'settings.advancedSection.folderIsGone' | transloco }}</span>
                      }
                    </div>
                    @if (entry.known) {
                      <div class="hint">{{ 'settings.advancedSection.aFolderPiKitHasOpened' | transloco }}</div>
                    }
                  </div>
                  <div class="ctl ctl-w">
                    <button
                      type="button"
                      class="btn btn-sm"
                      [attr.aria-label]="('settings.advancedSection.revokeTheAnswerFor' | transloco) + entry.path"
                      (click)="store.revokeTrust(entry.path)"
                    >
                      {{ 'settings.advancedSection.revoke' | transloco }}
                    </button>
                  </div>
                </div>
              } @empty {
                <div class="row">
                  <div class="hint">
                    {{
                      store.trustList()
                        ? ('settings.advancedSection.piHasNoSavedAnswer' | transloco)
                        : ('settings.advancedSection.readingPiSTrustList' | transloco)
                    }}
                  </div>
                </div>
              }
            </section>
          </pk-tab-panel>
        }
      </pk-tabs>
      @if (storageChoice() !== undefined) {
        <div class="pk-wf" data-testid="credential-storage-modal">
          <button
            type="button"
            class="pk-backdrop"
            tabindex="-1"
            [disabled]="secrets.storageBusy()"
            [attr.aria-label]="'settings.advancedSection.storageCancel' | transloco"
            (click)="closeStorageChoice()"
          ></button>
          <section
            class="win"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="credential-storage-title"
            aria-describedby="credential-storage-description"
            tabindex="-1"
            cdkTrapFocus
            [cdkTrapFocusAutoCapture]="true"
            (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); closeStorageChoice()"
          >
            <header class="head">
              <h2 id="credential-storage-title">
                {{
                  (storageChoice()
                    ? 'settings.advancedSection.enableCredentialStorage'
                    : 'settings.advancedSection.useDirectKeys'
                  ) | transloco
                }}
              </h2>
            </header>
            <div class="body">
              <p class="m-0 text-sm" id="credential-storage-description">
                {{
                  (storageChoice()
                    ? 'settings.advancedSection.enableStorageWarning'
                    : 'settings.advancedSection.disableStorageWarning'
                  ) | transloco
                }}
              </p>
            </div>
            <footer class="foot justify-end">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                cdkFocusInitial
                [disabled]="secrets.storageBusy()"
                (click)="closeStorageChoice()"
              >
                {{ 'settings.advancedSection.storageCancel' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-sm"
                [class.btn-warning]="!storageChoice()"
                data-testid="credential-storage-confirm"
                [disabled]="secrets.storageBusy()"
                (click)="saveStorageChoice()"
              >
                {{ 'settings.advancedSection.storageConfirm' | transloco }}
              </button>
            </footer>
          </section>
        </div>
      }

      @if (secrets.recoveryKey(); as key) {
        <dialog
          class="modal modal-open"
          aria-labelledby="recovery-title"
          tabindex="-1"
          data-testid="recovery-dialog"
          (keydown.escape)="secrets.closeRecoveryKey()"
        >
          <div class="modal-box max-w-[520px] flex flex-col gap-4">
            <div id="recovery-title" class="t-xl">{{ 'settings.advancedSection.yourRecoveryKey' | transloco }}</div>
            <p class="t-sm m-0">
              {{ 'settings.advancedSection.thisIsTheKeyThatOpensPi' | transloco }}
              <b>{{ 'settings.advancedSection.itIsShownOnceAndNeverAgain' | transloco }}</b>
              {{ 'settings.advancedSection.writeItDownOrSaveItIn' | transloco }}
            </p>
            <code
              class="mono break-all p-3 rounded-lg bg-base-200 border border-base-300 select-all"
              data-testid="recovery-key"
              >{{ key }}</code
            >
            <p class="t-sm muted m-0">
              {{ 'settings.advancedSection.toUseItLaterStartPiKit' | transloco }}
              <span class="mono">{{ 'settings.advancedSection.pIKITDBKEY' | transloco }}</span>
              {{ 'settings.advancedSection.setToThisKeyPiSSession' | transloco }}
            </p>
            <div class="modal-action m-0">
              <button type="button" class="btn btn-sm" (click)="copyKey(key)">
                {{ 'settings.advancedSection.copy' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-testid="recovery-done"
                (click)="secrets.closeRecoveryKey()"
              >
                {{ 'settings.advancedSection.iHaveSavedIt' | transloco }}
              </button>
            </div>
          </div>
        </dialog>
      }
    </div>
  `,
})
export class AdvancedSection {
  /** The first-run flow can be walked again from here (and with `/setup`): it shows what the machine has and the defaults, and changes nothing by itself. */
  protected readonly ui = inject(UiStore);
  protected readonly storageChoice = signal<boolean | undefined>(undefined);

  protected closeStorageChoice(): void {
    if (!this.secrets.storageBusy()) this.storageChoice.set(undefined);
  }

  protected async saveStorageChoice(): Promise<void> {
    const enabled = this.storageChoice();
    if (enabled === undefined) return;
    if (await this.secrets.setCredentialStorage(enabled)) this.storageChoice.set(undefined);
  }

  protected readonly tab = signal('diagnostics');
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly secrets = inject(SecretsStore);
  protected readonly redaction = inject(RedactionStore);
  protected readonly prefs = inject(ViewPrefs);
  /** What this window runs with; the toggle offers a reload while they differ. */
  protected readonly inspectorAtStart = inject(COPILOT_INSPECTOR_AT_START);
  /** The pattern being typed (local to this page: nothing is saved until Add). */
  protected readonly draftName = signal('');
  protected readonly draftRegex = signal('');
  protected readonly draftError = signal('');

  constructor() {
    void this.store.loadDiagnostics();
    void this.store.loadTrustList();
    void this.secrets.loadStatus();
    void this.secrets.loadProtection();
    void this.redaction.load();
  }

  protected diskTone(): string {
    const state = this.secrets.protection()?.disk.state;
    return state === 'on' ? 'ok' : state === 'off' ? 'warn' : 'off';
  }

  protected redactionOn(cwd: string): boolean {
    return !this.redaction.config().offFor.includes(cwd);
  }

  private async saveConfig(config: RedactionConfig): Promise<void> {
    await this.store.save(
      () =>
        this.redaction
          .save(config)
          .then((ok) =>
            ok ? true : Promise.reject(new Error(this.i18n.t('settings.advancedSection.theBackendDidNotTakeIt'))),
          ),
      this.i18n.t('settings.advancedSection.couldNotSaveTheRedactionSettings'),
    );
  }

  protected setFolder(cwd: string, on: boolean): Promise<void> {
    const current = this.redaction.config();
    const offFor = on ? current.offFor.filter((c) => c !== cwd) : [...current.offFor.filter((c) => c !== cwd), cwd];
    return this.saveConfig({ ...current, offFor });
  }

  protected addPattern(event: Event): Promise<void> {
    event.preventDefault();
    const pattern: UserRedactionPattern = { name: this.draftName().trim(), regex: this.draftRegex().trim() };
    // The expression is tried here first, with the same function the backend uses, so a typo says what is wrong instead of being saved and doing nothing.
    const { errors } = compileUserPatterns([pattern]);
    if (errors.length > 0) {
      this.draftError.set(errors[0]);
      return Promise.resolve();
    }
    this.draftError.set('');
    this.draftName.set('');
    this.draftRegex.set('');
    const current = this.redaction.config();
    return this.saveConfig({ ...current, patterns: [...current.patterns, pattern] });
  }

  protected removePattern(index: number): Promise<void> {
    const current = this.redaction.config();
    return this.saveConfig({ ...current, patterns: current.patterns.filter((_, i) => i !== index) });
  }

  /** Copies the recovery key to the clipboard on the person's click; this code keeps it nowhere else. */
  protected async copyKey(key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      // The key is on screen to select by hand.
    }
  }

  /** CopilotKit reads `enableInspector` once at bootstrap; a reload starts the window with the saved choice. */
  protected reload(): void {
    location.reload();
  }

  protected bytes = size;
  protected started(at: number): string {
    return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  }
}
