import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { compactNumber, formatCost } from '@pi-kit/ui';
import { formatSeconds } from '@pi-kit/chat/util';
import { ViewPrefs, DialogStore } from '@pi-kit/data-access';
import { Prose } from '@pi-kit/chat/ui';

/** Shortcuts shown by `/hotkeys`. */
export const hotkeyDescriptions = (translate: Translate): { keys: string; does: string }[] => [
  { keys: '⌘N', does: translate('chat.dialogHost.newThreadTheWhereRowStartsFrom') },
  { keys: '⌘⇧N', does: translate('chat.dialogHost.newThreadInAWorktree') },
  { keys: '⌘K', does: translate('chat.dialogHost.commandPalette') },
  { keys: '⌘⇧M', does: translate('chat.dialogHost.switchToTheNextPinnedModel') },
  { keys: '⌘⇧E', does: translate('chat.dialogHost.switchToTheNextEffortLevel') },
  { keys: '⌘⇧F', does: translate('chat.dialogHost.filterTheFilesPanel') },
  { keys: 'Esc', does: translate('chat.dialogHost.stopTheRunOrCloseAMenu') },
  { keys: '↑', does: translate('chat.dialogHost.inAnEmptyComposerBringBackYour') },
  { keys: '/', does: translate('chat.dialogHost.commandsSkillsTemplatesExtensionsBuiltIns') },
  { keys: '@', does: translate('chat.dialogHost.completeAFilePathInTheThread') },
  { keys: '!', does: translate('chat.dialogHost.runAShellCommandKeepsItsOutput') },
  { keys: '⏎  /  ⇧⏎', does: translate('chat.dialogHost.sendNewLine') },
];

/** The modal dialogs of `/session`, `/cost` (usage), `/hotkeys`, `/changelog` and `/name` (daisyUI `modal`). */
@Component({
  selector: 'pk-dialog-host',
  imports: [Prose, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (dialogs.current(); as dialog) {
      <dialog
        class="modal modal-open"
        [attr.aria-label]="dialog.kind === 'name' ? dialog.title : title(dialog.kind)"
        tabindex="-1"
        (keydown.escape)="dialogs.close()"
      >
        <div class="modal-box" [class.max-w-4xl]="dialog.kind === 'usage'">
          <h3 class="t-xl mb-4">{{ dialog.kind === 'name' ? dialog.title : title(dialog.kind) }}</h3>
          @switch (dialog.kind) {
            @case ('session') {
              @if (dialog.kind === 'session') {
                <table class="table table-sm">
                  <tbody>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.session' | transloco }}</th>
                      <td class="mono break-all">{{ dialog.stats.sessionId }}</td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.file' | transloco }}</th>
                      <td class="mono break-all">
                        {{ dialog.stats.sessionFile ?? ('chat.dialogHost.notWrittenYet' | transloco) }}
                      </td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.folder' | transloco }}</th>
                      <td class="mono break-all">{{ dialog.stats.cwd }}</td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.model' | transloco }}</th>
                      <td>
                        {{
                          'chat.dialogHost.thinking'
                            | transloco
                              : {
                                  value1: dialog.stats.model
                                    ? dialog.stats.model.provider + '/' + dialog.stats.model.id
                                    : ('chat.dialogHost.none' | transloco),
                                  value2: ('common.effortValue.' + dialog.stats.thinkingLevel | transloco),
                                }
                        }}
                      </td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.messages' | transloco }}</th>
                      <td>
                        {{
                          'chat.dialogHost.fromYouFromPiToolCalls'
                            | transloco
                              : {
                                  value1: dialog.stats.userMessages,
                                  value2: dialog.stats.assistantMessages,
                                  value3: dialog.stats.toolCalls,
                                }
                        }}
                      </td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.tokens' | transloco }}</th>
                      <td>
                        {{
                          'chat.dialogHost.inOutCacheReadCacheWrite'
                            | transloco
                              : {
                                  value1: n(dialog.stats.tokens.input),
                                  value2: n(dialog.stats.tokens.output),
                                  value3: n(dialog.stats.tokens.cacheRead),
                                  value4: n(dialog.stats.tokens.cacheWrite),
                                }
                        }}
                      </td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.context' | transloco }}</th>
                      <td>
                        {{
                          dialog.stats.contextTokens === null
                            ? ('chat.dialogHost.unknownUntilTheNextResponse' | transloco)
                            : n(dialog.stats.contextTokens)
                        }}{{
                          dialog.stats.contextWindow
                            ? ('chat.dialogHost.of' | transloco) + n(dialog.stats.contextWindow)
                            : ''
                        }}
                      </td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted">{{ 'chat.dialogHost.cost' | transloco }}</th>
                      <td>{{ cost(dialog.stats.cost) }}</td>
                    </tr>
                    <tr>
                      <th class="font-normal text-muted whitespace-nowrap">
                        {{ 'chat.dialogHost.autoCompaction' | transloco }}
                      </th>
                      <td>
                        {{
                          dialog.stats.autoCompaction
                            ? ('chat.dialogHost.on' | transloco)
                            : ('chat.dialogHost.off' | transloco)
                        }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              }
            }
            @case ('usage') {
              @if (dialog.kind === 'usage') {
                @let u = dialog.usage;
                <div class="pk-usage-totals" data-testid="usage-totals">
                  <div>
                    <div class="k">{{ 'chat.dialogHost.cost' | transloco }}</div>
                    <div class="v" data-testid="usage-cost">{{ cost(u.totals.cost) }}</div>
                  </div>
                  <div>
                    <div class="k">{{ 'chat.dialogHost.tokens' | transloco }}</div>
                    <div class="v" data-testid="usage-tokens">{{ full(u.totals.total) }}</div>
                  </div>
                  <div>
                    <div class="k">{{ 'chat.dialogHost.turns' | transloco }}</div>
                    <div class="v" data-testid="usage-turns">{{ u.totals.turns }}</div>
                  </div>
                  <div>
                    <div class="k">{{ 'chat.dialogHost.requests' | transloco }}</div>
                    <div class="v">{{ u.totals.requests }}</div>
                  </div>
                  <div>
                    <div class="k">{{ 'chat.dialogHost.cacheHit' | transloco }}</div>
                    <div class="v">
                      {{
                        u.cacheHitRatio === null
                          ? ('chat.dialogHost.nA' | transloco)
                          : (u.cacheHitRatio * 100).toFixed(0) + '%'
                      }}
                    </div>
                  </div>
                </div>
                <p class="t-sm muted mb-4">
                  {{
                    'chat.dialogHost.inOutCacheReadCacheWriteCounted'
                      | transloco
                        : {
                            value1: full(u.totals.input),
                            value2: full(u.totals.output),
                            value3: full(u.totals.cacheRead),
                            value4: full(u.totals.cacheWrite),
                          }
                  }}
                </p>

                <h4 class="font-medium mb-1">{{ 'chat.dialogHost.byModel' | transloco }}</h4>
                <div class="pk-usage-table mb-4">
                  <table
                    class="table table-sm"
                    [attr.aria-label]="'chat.dialogHost.usageByModel' | transloco"
                    data-testid="usage-by-model"
                  >
                    <thead>
                      <tr>
                        <th>{{ 'chat.dialogHost.model' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.requests' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.in' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.out' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.cacheRead' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.cacheWrite' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.cost' | transloco }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (m of u.byModel; track m.provider + '/' + m.model) {
                        <tr>
                          <td class="mono">{{ m.provider ? m.provider + '/' + m.model : m.model }}</td>
                          <td class="num">{{ full(m.requests) }}</td>
                          <td class="num">{{ full(m.input) }}</td>
                          <td class="num">{{ full(m.output) }}</td>
                          <td class="num">{{ full(m.cacheRead) }}</td>
                          <td class="num">{{ full(m.cacheWrite) }}</td>
                          <td class="num">{{ cost(m.cost) }}</td>
                        </tr>
                      } @empty {
                        <tr>
                          <td colspan="7" class="muted">
                            {{ 'chat.dialogHost.noModelRequestsInThisSessionYet' | transloco }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>

                <h4 class="font-medium mb-1">{{ 'chat.dialogHost.byTurn' | transloco }}</h4>
                <div class="pk-usage-table mb-4 max-h-72 overflow-y-auto">
                  <table
                    class="table table-sm table-pin-rows"
                    [attr.aria-label]="'chat.dialogHost.usageByTurn' | transloco"
                    data-testid="usage-by-turn"
                  >
                    <thead>
                      <tr>
                        <th class="num">#</th>
                        <th>{{ 'chat.dialogHost.message' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.in' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.out' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.cacheRead' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.cacheWrite' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.cost' | transloco }}</th>
                        <th class="num">{{ 'chat.dialogHost.time' | transloco }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (t of u.byTurn; track t.turn) {
                        <tr data-testid="usage-turn-row" [attr.title]="t.models.join(', ')">
                          <td class="num">{{ t.turn || '·' }}</td>
                          <td>
                            <div class="preview">{{ t.preview }}</div>
                          </td>
                          <td class="num">{{ full(t.input) }}</td>
                          <td class="num">{{ full(t.output) }}</td>
                          <td class="num">{{ full(t.cacheRead) }}</td>
                          <td class="num">{{ full(t.cacheWrite) }}</td>
                          <td class="num">{{ cost(t.cost) }}</td>
                          <td class="num">{{ t.elapsedMs ? seconds(t.elapsedMs) : '' }}</td>
                        </tr>
                      } @empty {
                        <tr>
                          <td colspan="8" class="muted">{{ 'chat.dialogHost.nothingHasBeenSentYet' | transloco }}</td>
                        </tr>
                      }
                    </tbody>
                    <tfoot>
                      <tr class="font-medium">
                        <td></td>
                        <td>{{ 'chat.dialogHost.total' | transloco }}</td>
                        <td class="num" data-testid="usage-sum-in">{{ full(u.totals.input) }}</td>
                        <td class="num" data-testid="usage-sum-out">{{ full(u.totals.output) }}</td>
                        <td class="num">{{ full(u.totals.cacheRead) }}</td>
                        <td class="num">{{ full(u.totals.cacheWrite) }}</td>
                        <td class="num">{{ cost(u.totals.cost) }}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <h4 class="font-medium mb-1">{{ 'chat.dialogHost.compactions' | transloco }}</h4>
                @if (u.compactions.length === 0) {
                  <p class="t-sm muted mb-4">{{ 'chat.dialogHost.theContextHasNotBeenCompacted' | transloco }}</p>
                } @else {
                  <ul
                    class="t-sm mb-4 flex flex-col gap-1"
                    [attr.aria-label]="'chat.dialogHost.compactionHistory' | transloco"
                    data-testid="usage-compactions"
                  >
                    @for (c of u.compactions; track c.entryId) {
                      <li>
                        <span class="muted">{{ c.timestamp ? when(c.timestamp) : '' }}</span>

                        {{
                          'chat.dialogHost.tokensBefore'
                            | transloco
                              : {
                                  value1: full(c.tokensBefore),
                                  value2:
                                    c.tokensAfter === undefined
                                      ? ''
                                      : ('chat.dialogHost.about' | transloco) +
                                        full(c.tokensAfter) +
                                        ('chat.dialogHost.after' | transloco),
                                }
                        }}
                      </li>
                    }
                  </ul>
                }

                <label class="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    class="toggle toggle-sm"
                    [checked]="prefs.showUsage()"
                    (change)="prefs.setShowUsage($any($event.target).checked)"
                  />
                  <span class="t-sm"
                    >{{ 'chat.dialogHost.showUsageUnderEveryTurn' | transloco }}
                    <span class="muted">{{ 'chat.dialogHost.otherwiseItShowsWhenYouHoverA' | transloco }}</span></span
                  >
                </label>
              }
            }
            @case ('hotkeys') {
              <table class="table table-sm">
                <tbody>
                  @for (key of hotkeys; track key.keys) {
                    <tr>
                      <td class="w-32">
                        <kbd class="kbd kbd-sm">{{ key.keys }}</kbd>
                      </td>
                      <td>{{ key.does }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
            @case ('changelog') {
              @if (dialog.kind === 'changelog') {
                <p class="text-sm text-muted mb-2">
                  {{ 'chat.dialogHost.pi' | transloco: { value1: dialog.version } }}
                </p>
                <div class="max-h-96 overflow-y-auto"><pk-prose [text]="dialog.text" /></div>
              }
            }
            @case ('name') {
              @if (dialog.kind === 'name') {
                <form (submit)="$event.preventDefault(); dialogs.submitName(field.value)">
                  <input
                    #field
                    class="input w-full"
                    type="text"
                    [attr.aria-label]="dialog.title"
                    [attr.placeholder]="dialog.placeholder"
                    [value]="dialog.current"
                  />
                  <div class="modal-action">
                    <button type="button" class="btn btn-ghost btn-sm" (click)="dialogs.close()">
                      {{ 'chat.dialogHost.cancel' | transloco }}
                    </button>
                    <button type="submit" class="btn btn-primary btn-sm">
                      {{ 'chat.dialogHost.save' | transloco }}
                    </button>
                  </div>
                </form>
              }
            }
          }
          @if (dialog.kind !== 'name') {
            <div class="modal-action">
              <button type="button" class="btn btn-sm" (click)="dialogs.close()">
                {{ 'chat.dialogHost.close' | transloco }}
              </button>
            </div>
          }
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="button" (click)="dialogs.close()">{{ 'chat.dialogHost.closeda388' | transloco }}</button>
        </form>
      </dialog>
    }
  `,
})
export class DialogHost {
  protected readonly i18n = inject(Language);
  protected readonly dialogs = inject(DialogStore);
  protected readonly prefs = inject(ViewPrefs);
  protected get hotkeys() {
    return hotkeyDescriptions(this.i18n.t);
  }
  protected readonly n = (v: number) => (v >= 10_000 ? compactNumber(v) : v.toLocaleString(this.i18n.locale()));
  protected readonly cost = formatCost;
  protected readonly full = (v: number) => v.toLocaleString(this.i18n.locale());
  protected readonly seconds = formatSeconds;
  protected readonly when = (iso: string) =>
    new Date(iso).toLocaleString(this.i18n.locale(), { dateStyle: 'medium', timeStyle: 'short' });

  protected title(kind: string): string {
    switch (kind) {
      case 'session':
        return this.i18n.t('chat.dialogHost.session');
      case 'usage':
        return this.i18n.t('chat.dialogHost.usage');
      case 'hotkeys':
        return this.i18n.t('chat.dialogHost.keyboardShortcuts');
      case 'changelog':
        return this.i18n.t('chat.dialogHost.changelog');
      default:
        return this.i18n.t('chat.dialogHost.nameThisThread');
    }
  }
}
