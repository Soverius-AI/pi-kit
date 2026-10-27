import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { CONNECTOR_EXPOSURE_TEXT, type McpExposure, type McpServerBody, type McpServerCreate } from '@pi-kit/protocol';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { SecretsStore } from '@pi-kit/settings/api';
import {
  type KvRow,
  type ServerForm,
  blankRow,
  bodyOfForm,
  checkToken,
  createOfForm,
  previewText,
  secretHint,
  withKey,
  withMark,
  withValue,
} from '@pi-kit/settings/util';

type RowList = 'headers' | 'env';

const exposureDescriptions = (translate: Translate): Record<McpExposure, string> => ({
  direct: translate('settings.serverForm.everyToolIsInTheModelS'),
  deferred: translate('settings.serverForm.listedOnDemandSavesContext'),
  codemode: translate('settings.serverForm.calledFromCodeTheModelWrites'),
  hidden: translate('settings.serverForm.registeredButOutOfReach'),
});
const EXPOSURES: readonly McpExposure[] = ['direct', 'deferred', 'codemode', 'hidden'];

/**
 * The details form of an MCP server: name, runs at a URL or as a command, URL + headers as key/value rows or
 * command + arguments + environment as key/value rows, tools exposure, description, scope, and (editing) enabled; under it “As it will be written”, the JSON the file gets, live. It
 * is shared by the “Add a server” wizard (a server of your own) and the edit dialog, which own the form's state (`form`, a model) and what happens on Save.
 *
 * Secrets: a header or variable value that is a secret (the person locked it, its name says so, or it has the shape of a key) is typed into a password field with no reveal toggle and is
 * **not kept in the form's state**: the text lives in a private map by row until {@link body} hands it to the one request that sends it, and {@link clearSecrets} drops it. A value the
 * file already holds in the credential store shows as “Stored in your keychain” and is kept unless something is typed over it.
 */
@Component({
  selector: 'pk-server-form',
  imports: [NgTemplateOutlet, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let f = form();
    <form class="pk-form" autocomplete="off" (submit)="$event.preventDefault()" data-testid="server-form">
      <label for="srv-name">{{ 'settings.serverForm.name' | transloco }}</label>
      <input
        id="srv-name"
        name="name"
        class="input input-sm mono"
        [placeholder]="'settings.serverForm.myServer' | transloco"
        autocomplete="off"
        spellcheck="false"
        data-testid="custom-name"
        [value]="f.name"
        (input)="patch({ name: $any($event.target).value })"
      />
      <div class="hint">
        {{
          'settings.serverForm.lettersDigitsAndItsToolsAreCalled'
            | transloco: { value1: f.name || ('settings.serverForm.name6ae99' | transloco) }
        }}
      </div>

      <label for="srv-kind">{{ 'settings.serverForm.runs' | transloco }}</label>
      <select
        id="srv-kind"
        name="kind"
        class="select select-sm"
        data-testid="custom-kind"
        (change)="patch({ kind: $any($event.target).value })"
      >
        <option value="url" [selected]="f.kind === 'url'">{{ 'settings.serverForm.atAURLHTTP' | transloco }}</option>
        <option value="command" [selected]="f.kind === 'command'">
          {{ 'settings.serverForm.asACommandOnThisMachineStdio' | transloco }}
        </option>
      </select>

      @if (f.kind === 'url') {
        <label for="srv-url">{{ 'settings.serverForm.uRL' | transloco }}</label>
        <input
          id="srv-url"
          name="url"
          class="input input-sm mono"
          [placeholder]="'settings.serverForm.httpsExampleComMcp' | transloco"
          autocomplete="off"
          spellcheck="false"
          data-testid="custom-url"
          [value]="f.url"
          (input)="patch({ url: $any($event.target).value })"
        />
        <div class="hint">
          {{ 'settings.serverForm.httpsOrHttpOnThisMachineWith' | transloco }}
        </div>
        <label for="srv-headers-add">{{ 'settings.serverForm.headers' | transloco }}</label>
        <div
          class="kvs"
          role="group"
          [attr.aria-label]="'settings.serverForm.headers' | transloco"
          data-testid="headers"
        >
          <ng-container
            [ngTemplateOutlet]="rowsTpl"
            [ngTemplateOutletContext]="{
              list: 'headers',
              rows: f.headers,
              keyLabel: 'Header',
              keyPlaceholder: 'Header',
            }"
          />
        </div>
        <div class="hint">{{ hint() }}</div>
      } @else {
        <label for="srv-command">{{ 'settings.serverForm.command' | transloco }}</label>
        <input
          id="srv-command"
          name="command"
          class="input input-sm mono"
          [placeholder]="'settings.serverForm.npx' | transloco"
          autocomplete="off"
          spellcheck="false"
          data-testid="custom-command"
          [value]="f.command"
          (input)="patch({ command: $any($event.target).value })"
        />
        <div class="hint">{{ 'settings.serverForm.oneProgramItIsLookedUpOn' | transloco }}</div>
        <label for="srv-args">{{ 'settings.serverForm.arguments' | transloco }}</label>
        <input
          id="srv-args"
          name="args"
          class="input input-sm mono"
          [placeholder]="'settings.serverForm.ySomeMcpServerFlag' | transloco"
          autocomplete="off"
          spellcheck="false"
          data-testid="custom-args"
          [value]="f.args"
          (input)="patch({ args: $any($event.target).value })"
        />
        <div class="hint">{{ 'settings.serverForm.oneLineQuotesGroupAnArgument' | transloco }}</div>
        <label for="srv-env-add">{{ 'settings.serverForm.environment' | transloco }}</label>
        <div
          class="kvs"
          role="group"
          [attr.aria-label]="'settings.serverForm.environment' | transloco"
          data-testid="env"
        >
          <ng-container
            [ngTemplateOutlet]="rowsTpl"
            [ngTemplateOutletContext]="{ list: 'env', rows: f.env, keyLabel: 'Variable', keyPlaceholder: 'NAME' }"
          />
        </div>
        <div class="hint">{{ hint() }}</div>
      }

      <label for="srv-exposure">{{ 'settings.serverForm.tools' | transloco }}</label>
      <select
        id="srv-exposure"
        class="select select-sm"
        data-testid="details-exposure"
        (change)="patch({ exposure: $any($event.target).value })"
      >
        @for (e of exposures; track e) {
          <option [value]="e" [selected]="f.exposure === e">{{ exposureText(e) }}</option>
        }
      </select>

      <label for="srv-description">{{ 'settings.serverForm.description' | transloco }}</label>
      <input
        id="srv-description"
        name="description"
        class="input input-sm"
        [placeholder]="'settings.serverForm.whatItIsFor' | transloco"
        autocomplete="off"
        data-testid="custom-description"
        [value]="f.description"
        (input)="patch({ description: $any($event.target).value })"
      />

      <label for="srv-scope">{{ 'settings.serverForm.scope' | transloco }}</label>
      <select
        id="srv-scope"
        class="select select-sm"
        data-testid="details-scope"
        [disabled]="mode() === 'edit'"
        (change)="patch({ scope: $any($event.target).value })"
      >
        <option value="user" [selected]="f.scope === 'user'">
          {{ 'settings.serverForm.forMeUserMcpJson' | transloco }}
        </option>
        <option value="project" [selected]="f.scope === 'project'" [disabled]="!projectAllowed()">
          {{ 'settings.serverForm.thisProjectPiMcpJson' | transloco }}
        </option>
      </select>
      @if (scopeHint(); as text) {
        <div class="hint" data-testid="scope-hint">{{ text }}</div>
      }

      @if (mode() === 'edit') {
        <label for="srv-enabled">{{ 'settings.serverForm.enabled' | transloco }}</label>
        <div>
          <input
            id="srv-enabled"
            type="checkbox"
            class="toggle toggle-sm toggle-primary"
            data-testid="details-enabled"
            [checked]="f.enabled"
            (change)="patch({ enabled: $any($event.target).checked })"
          />
        </div>
      }
    </form>

    @if (kept().length > 0) {
      <p class="hint m-0" data-testid="kept-keys">
        {{ 'settings.serverForm.alsoInTheFileAndKeptAs' | transloco }} <span class="mono">{{ kept().join(', ') }}</span
        >.
      </p>
    }
    <details class="t-sm" data-testid="as-written">
      <summary class="cursor-pointer muted">{{ 'settings.serverForm.asItWillBeWritten' | transloco }}</summary>
      <pre
        class="mono t-sm mt-2 p-3 rounded-lg overflow-auto"
        style="background: var(--color-base-200); border: 1px solid var(--color-base-300)"
        data-testid="as-written-text"
        >{{ written() }}</pre>
    </details>

    <ng-template #rowsTpl let-list="list" let-rows="rows" let-keyLabel="keyLabel" let-keyPlaceholder="keyPlaceholder">
      @for (row of rows; track row.uid; let i = $index) {
        <input
          class="input input-sm"
          [placeholder]="keyPlaceholder"
          [attr.aria-label]="keyLabel + ' ' + (i + 1) + ('settings.serverForm.namea6964' | transloco)"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          [attr.data-testid]="list + '-key-' + i"
          [value]="row.key"
          (input)="setKey(list, row, $any($event.target).value)"
        />
        <input
          class="input input-sm"
          [class.stored]="row.stored && !row.filled"
          [type]="row.secret ? 'password' : 'text'"
          [placeholder]="
            row.stored && !row.filled
              ? ('settings.serverForm.storedInYourKeychainTypeToReplace' | transloco)
              : ('settings.serverForm.value' | transloco)
          "
          [attr.aria-label]="keyLabel + ' ' + (i + 1) + ('settings.serverForm.value67554' | transloco)"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          [attr.data-testid]="list + '-value-' + i"
          [attr.data-secret]="row.secret ? 'true' : null"
          [value]="row.shown"
          (input)="setValue(list, row, $any($event.target).value)"
        />
        <button
          type="button"
          class="btn btn-sm btn-ghost btn-square lock"
          [attr.aria-pressed]="row.marked || row.stored"
          [pkTip]="
            row.stored
              ? ('settings.serverForm.keptInYourKeychain' | transloco)
              : row.marked
                ? ((protectedStorage()
                    ? 'settings.serverForm.keptInYourKeychainClickToKeep'
                    : 'settings.serverForm.secretInPrivateFile'
                  ) | transloco)
                : ((protectedStorage()
                    ? 'settings.serverForm.keepTheValueInYourKeychain'
                    : 'settings.serverForm.markPrivateFileSecret'
                  ) | transloco)
          "
          [attr.aria-label]="
            (row.stored || protectedStorage()
              ? 'settings.serverForm.keepTheValueInTheKeychain'
              : 'settings.serverForm.markPrivateFileSecret'
            ) | transloco
          "
          [attr.data-testid]="list + '-lock-' + i"
          [disabled]="row.stored"
          (click)="mark(list, row)"
        >
          <pk-icon name="lock" />
        </button>
        <button
          type="button"
          class="btn btn-sm btn-ghost btn-square"
          [pkTip]="'settings.serverForm.remove' | transloco"
          [attr.aria-label]="'settings.serverForm.remove' | transloco"
          [attr.data-testid]="list + '-remove-' + i"
          (click)="remove(list, row)"
        >
          ×
        </button>
      }
      <button
        type="button"
        class="btn btn-xs btn-ghost add-row"
        [id]="'srv-' + list + '-add'"
        [attr.data-testid]="list + '-add'"
        (click)="add(list)"
      >
        {{
          'settings.serverForm.add'
            | transloco
              : {
                  value1:
                    list === 'headers'
                      ? ('settings.serverForm.aHeader' | transloco)
                      : ('settings.serverForm.aVariable' | transloco),
                }
        }}
      </button>
    </ng-template>
  `,
})
export class PkServerForm {
  protected readonly i18n = inject(Language);
  /** The form's state. The component changes it through `patch` and the row methods; the host reads it. */
  readonly form = model.required<ServerForm>();
  readonly mode = input<'add' | 'edit'>('add');
  readonly projectAllowed = input(true);
  /** Why “This project” is not offered, under the scope select. */
  readonly projectWhy = input('');
  /** Keys of the entry that the form does not own (`oauth`, `timeout`…), said under the form. */
  readonly kept = input<string[]>([]);

  private readonly secretsStore = inject(SecretsStore);
  /** The typed text of the rows that hold a secret, by row. Not state: nothing renders it, and it is dropped when the request has gone. */
  private secrets = new Map<number, string>();

  protected readonly exposures = EXPOSURES;
  protected readonly protectedStorage = computed(() => this.secretsStore.status()?.available === true);
  protected readonly hint = computed(() => secretHint(this.i18n.t, this.secretsStore.status()));
  protected readonly written = computed(() => previewText(this.form(), this.secrets));
  protected readonly scopeHint = computed(() =>
    this.form().scope === 'user' && !this.projectAllowed() && this.projectWhy() ? this.projectWhy() : '',
  );

  /** Seeds the secrets of a form that was loaded from a file (a literal in the file that looks like a secret). */
  load(form: ServerForm, secrets: ReadonlyMap<number, string>): void {
    this.secrets = new Map(secrets);
    this.form.set(form);
  }

  /** The body for `PATCH`; typed secrets are in it for that one request. */
  body(): McpServerBody {
    return bodyOfForm(this.form(), this.secrets);
  }
  create(): McpServerCreate {
    return createOfForm(this.form(), this.secrets);
  }
  /** The `Authorization` token the reachability check may send. */
  token(): string | undefined {
    return checkToken(this.form(), this.secrets);
  }
  /** Drops every typed secret, and empties the password fields: the request that used them has left. */
  clearSecrets(): void {
    this.secrets.clear();
  }

  protected exposureText(e: McpExposure): string {
    const label = e === 'hidden' ? this.i18n.t('settings.serverForm.hidden') : CONNECTOR_EXPOSURE_TEXT[e].label;
    return `${label} — ${exposureDescriptions(this.i18n.t)[e]}`;
  }

  protected patch(patch: Partial<ServerForm>): void {
    this.form.update((f) => ({ ...f, ...patch }));
  }

  private rows(list: RowList): KvRow[] {
    return this.form()[list];
  }
  private setRows(list: RowList, rows: KvRow[]): void {
    this.form.update((f) => ({ ...f, [list]: rows }));
  }
  private replace(list: RowList, row: KvRow): void {
    this.setRows(
      list,
      this.rows(list).map((r) => (r.uid === row.uid ? row : r)),
    );
  }

  protected add(list: RowList): void {
    this.setRows(list, [...this.rows(list), blankRow()]);
  }
  protected remove(list: RowList, row: KvRow): void {
    this.secrets.delete(row.uid);
    this.setRows(
      list,
      this.rows(list).filter((r) => r.uid !== row.uid),
    );
  }
  protected setKey(list: RowList, row: KvRow, key: string): void {
    const changed = withKey(row, key);
    if (changed.moved !== undefined) this.secrets.set(row.uid, changed.moved);
    this.replace(list, changed.row);
  }
  protected setValue(list: RowList, row: KvRow, text: string): void {
    const changed = withValue(row, text);
    if (changed.secretText !== undefined) this.secrets.set(row.uid, changed.secretText);
    else this.secrets.delete(row.uid);
    this.replace(list, changed.row);
  }
  protected mark(list: RowList, row: KvRow): void {
    const changed = withMark(row, !row.marked, this.secrets.get(row.uid));
    if (changed.moved !== undefined) this.secrets.set(row.uid, changed.moved);
    if (changed.restored !== undefined) this.secrets.delete(row.uid);
    this.replace(list, changed.row);
  }
}
