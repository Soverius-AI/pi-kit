import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { PkTabs, PkTabPanel, PkScrollArea } from '@pi-kit/design-system';
import { IS_MAC } from '@pi-kit/data-access';
import { SettingsStore } from '@pi-kit/settings/data';
import {
  fixedShortcuts,
  kitShortcuts,
  comboFromEvent,
  formatCombo,
  shortcutBindings,
  shortcutLabel,
  usedBy,
} from '@pi-kit/ui';

type Scope = 'pi-kit' | 'pi';
interface Target {
  scope: Scope;
  id: string;
}
/** A recorded key that another action already uses: asks before it takes it. */
interface Clash extends Target {
  combo: string;
  with: string[];
}

/**
 * Settings › Keybindings: pi-kit’s shortcuts and pi’s own, editable, with conflicts flagged and a JSON export and import.
 * Clicking “Change” records the next key press (Esc cancels); a key another action already has is not taken silently, the row says who has it and
 * offers to use it anyway. pi-kit’s shortcuts are saved in its database; pi’s go to `keybindings.json` of the agent folder, which the pi
 * command line reads too, and take effect in a running session after a reload. Clashes that already exist (an imported file, a hand-edited
 * `keybindings.json`) are flagged in red on both rows.
 */
@Component({
  imports: [PkTabs, PkTabPanel, PkScrollArea, TranslocoPipe],
  selector: 'pk-keybindings-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-keybindings">
      <pk-tabs [label]="'shared.catalog.keybindings' | transloco" [(value)]="tab" (valueChange)="stopRecording()">
        @if (store.shows('keys-pi-kit')) {
          <pk-tab-panel value="pi-kit" [label]="'settings.keybindingsSection.piKitShortcuts' | transloco">
            <section
              class="pk-group pk-keys"
              [attr.aria-label]="'settings.keybindingsSection.piKitShortcuts' | transloco"
            >
              <header>
                <div>
                  <h4>{{ 'settings.keybindingsSection.piKit' | transloco }}</h4>
                  <p>{{ 'settings.keybindingsSection.handledByThisWindow' | transloco }}</p>
                </div>
                <span class="chip store">{{ storageKit }}</span>
                @if (store.kitConflicts().size > 0) {
                  <span class="chip err" data-testid="kit-conflicts">{{
                    'settings.keybindingsSection.clash' | transloco: { value1: store.kitConflicts().size }
                  }}</span>
                }
              </header>
              <div class="px-4 py-3 border-b border-base-300">
                <input
                  type="search"
                  class="input input-sm w-full"
                  [attr.aria-label]="'settings.keybindingsSection.filterShortcuts' | transloco"
                  [placeholder]="'settings.keybindingsSection.filterShortcuts' | transloco"
                  [value]="query()"
                  (focus)="stopRecording()"
                  (input)="query.set($any($event.target).value)"
                />
              </div>
              <pk-scroll-area
                class="pk-scroll-area-flush"
                [label]="'settings.keybindingsSection.piKitShortcuts' | transloco"
              >
                @for (shortcut of kitRows(); track shortcut.id) {
                  <div class="row" [attr.data-testid]="'key-' + shortcut.id">
                    <div class="min-w-0">
                      <div class="lbl">
                        {{ shortcut.label }}
                        @if (shortcut.custom) {
                          <span class="chip">{{ 'settings.keybindingsSection.changed' | transloco }}</span>
                        }
                      </div>
                      @if (clashText('pi-kit', shortcut.id); as text) {
                        <div class="sub err" role="alert">{{ text }}</div>
                      }
                      @if (clash()?.scope === 'pi-kit' && clash()?.id === shortcut.id) {
                        <div class="sub err" role="alert" data-testid="clash-message">{{ clashSummary() }}</div>
                      }
                    </div>
                    <div class="ctl ctl-w wrap">
                      @if (isRecording('pi-kit', shortcut.id)) {
                        <button
                          type="button"
                          class="pk-keycap recording"
                          data-testid="recording"
                          (click)="stopRecording()"
                        >
                          {{ 'settings.keybindingsSection.pressTheNewKeys' | transloco }}
                        </button>
                      } @else {
                        <span
                          class="pk-keycap"
                          [class.custom]="shortcut.custom"
                          [class.clash]="store.kitConflicts().has(shortcut.id)"
                          [attr.aria-label]="('settings.keybindingsSection.shortcut' | transloco) + shortcut.display"
                          >{{ shortcut.display }}</span
                        >
                      }
                      @if (clash()?.scope === 'pi-kit' && clash()?.id === shortcut.id) {
                        <button type="button" class="btn btn-xs btn-primary" (click)="useAnyway()">
                          {{ 'settings.keybindingsSection.useItAnyway' | transloco }}
                        </button>
                        <button type="button" class="btn btn-xs btn-ghost" (click)="clash.set(undefined)">
                          {{ 'settings.keybindingsSection.cancel' | transloco }}
                        </button>
                      } @else if (!isRecording('pi-kit', shortcut.id)) {
                        <button
                          type="button"
                          class="btn btn-xs"
                          [attr.aria-label]="('settings.keybindingsSection.change' | transloco) + shortcut.label"
                          (click)="record('pi-kit', shortcut.id)"
                        >
                          {{ 'settings.keybindingsSection.change64fbd' | transloco }}
                        </button>
                        @if (shortcut.custom) {
                          <button
                            type="button"
                            class="btn btn-xs btn-ghost"
                            [attr.aria-label]="('settings.keybindingsSection.reset' | transloco) + shortcut.label"
                            (click)="store.setShortcut(shortcut.id, null)"
                          >
                            {{ 'settings.keybindingsSection.reset44c57' | transloco }}
                          </button>
                        }
                      }
                    </div>
                  </div>
                }
                @for (fixed of fixedRows(); track fixed.id) {
                  <div class="row">
                    <div class="min-w-0">
                      <div class="lbl muted">{{ fixed.label }}</div>
                    </div>
                    <div class="ctl ctl-w">
                      <span class="pk-keycap">{{ fixed.display }}</span
                      ><span class="t-xs muted">{{ 'settings.keybindingsSection.fixed' | transloco }}</span>
                    </div>
                  </div>
                }
                @if (kitRows().length === 0 && fixedRows().length === 0) {
                  <div class="row">
                    <div class="hint">{{ 'settings.keybindingsSection.noKeyMatchesTheSearch' | transloco }}</div>
                  </div>
                }
              </pk-scroll-area>
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('keys-pi')) {
          <pk-tab-panel value="pi" [label]="'settings.keybindingsSection.piShortcuts' | transloco">
            <section class="pk-group pk-keys" [attr.aria-label]="'settings.keybindingsSection.piShortcuts' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.keybindingsSection.piSTerminalShortcuts' | transloco }}</h4>
                  <p>
                    {{
                      store.overview()
                        ? ('settings.keybindingsSection.theKeysOfPiSOwnInterface' | transloco)
                        : ('settings.keybindingsSection.loading' | transloco)
                    }}
                  </p>
                </div>
                <span class="chip store">{{ 'settings.keybindingsSection.piKeybindingsJson' | transloco }}</span>
                @if (store.piConflicts().size > 0) {
                  <span class="chip err" data-testid="pi-conflicts">{{
                    'settings.keybindingsSection.clash' | transloco: { value1: store.piConflicts().size }
                  }}</span>
                }
              </header>
              <div class="px-4 py-3 border-b border-base-300">
                <input
                  type="search"
                  class="input input-sm w-full"
                  [attr.aria-label]="'settings.keybindingsSection.filterShortcuts' | transloco"
                  [placeholder]="'settings.keybindingsSection.filterShortcuts' | transloco"
                  [value]="query()"
                  (focus)="stopRecording()"
                  (input)="query.set($any($event.target).value)"
                />
              </div>
              <pk-scroll-area
                class="pk-scroll-area-flush"
                [label]="'settings.keybindingsSection.piShortcuts' | transloco"
              >
                @for (binding of piRows(); track binding.id) {
                  <div class="row" [attr.data-testid]="'key-' + binding.id">
                    <div class="min-w-0">
                      <div class="lbl">
                        {{ binding.description }}
                        @if (binding.custom) {
                          <span class="chip">{{ 'settings.keybindingsSection.changed' | transloco }}</span>
                        }
                      </div>
                      <div class="id">{{ binding.id }}</div>
                      @if (clashText('pi', binding.id); as text) {
                        <div class="sub err" role="alert">{{ text }}</div>
                      }
                      @if (clash()?.scope === 'pi' && clash()?.id === binding.id) {
                        <div class="sub err" role="alert" data-testid="clash-message">{{ clashSummary() }}</div>
                      }
                    </div>
                    <div class="ctl ctl-w wrap">
                      @if (isRecording('pi', binding.id)) {
                        <button
                          type="button"
                          class="pk-keycap recording"
                          data-testid="recording"
                          (click)="stopRecording()"
                        >
                          {{ 'settings.keybindingsSection.pressTheNewKeys' | transloco }}
                        </button>
                      } @else {
                        @for (key of binding.keys; track key) {
                          <span
                            class="pk-keycap"
                            [class.custom]="binding.custom"
                            [class.clash]="store.piConflicts().has(binding.id)"
                            >{{ key }}</span
                          >
                        } @empty {
                          <span class="t-sm muted">{{ 'settings.keybindingsSection.unbound' | transloco }}</span>
                        }
                      }
                      @if (clash()?.scope === 'pi' && clash()?.id === binding.id) {
                        <button type="button" class="btn btn-xs btn-primary" (click)="useAnyway()">
                          {{ 'settings.keybindingsSection.useItAnyway' | transloco }}
                        </button>
                        <button type="button" class="btn btn-xs btn-ghost" (click)="clash.set(undefined)">
                          {{ 'settings.keybindingsSection.cancel' | transloco }}
                        </button>
                      } @else if (!isRecording('pi', binding.id)) {
                        <button
                          type="button"
                          class="btn btn-xs"
                          [attr.aria-label]="('settings.keybindingsSection.change' | transloco) + binding.description"
                          (click)="record('pi', binding.id)"
                        >
                          {{ 'settings.keybindingsSection.change64fbd' | transloco }}
                        </button>
                        @if (binding.keys.length > 0) {
                          <button
                            type="button"
                            class="btn btn-xs btn-ghost"
                            [attr.aria-label]="('settings.keybindingsSection.unbind' | transloco) + binding.description"
                            (click)="store.setPiKeys(binding.id, [])"
                          >
                            {{ 'settings.keybindingsSection.unbinde4030' | transloco }}
                          </button>
                        }
                        @if (binding.custom) {
                          <button
                            type="button"
                            class="btn btn-xs btn-ghost"
                            [attr.aria-label]="('settings.keybindingsSection.reset' | transloco) + binding.description"
                            (click)="store.setPiKeys(binding.id, null)"
                          >
                            {{ 'settings.keybindingsSection.reset44c57' | transloco }}
                          </button>
                        }
                      }
                    </div>
                  </div>
                } @empty {
                  <div class="row">
                    <div class="hint">{{ 'settings.keybindingsSection.noKeyMatchesTheSearch' | transloco }}</div>
                  </div>
                }
              </pk-scroll-area>
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('keys-io')) {
          <pk-tab-panel value="transfer" [label]="'settings.keybindingsSection.exportAndImport' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.keybindingsSection.exportAndImport' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.keybindingsSection.exportAndImport' | transloco }}</h4>
                  <p>{{ 'settings.keybindingsSection.everyCustomShortcutAsOneJSONFile' | transloco }}</p>
                </div>
                <span class="chip store">{{ storageKit }}</span>
              </header>
              <div class="row">
                <div class="min-w-0">
                  <div class="lbl">{{ 'settings.keybindingsSection.shortcutFile' | transloco }}</div>
                  <div class="hint">
                    {{ 'settings.keybindingsSection.exportSavesPiKitSAndPi' | transloco }}
                  </div>
                  @if (message(); as text) {
                    <div class="sub" [class.warn]="messageWarn()" role="status" data-testid="import-message">
                      {{ text }}
                    </div>
                  }
                </div>
                <div class="ctl ctl-w wrap">
                  <button type="button" class="btn btn-sm" data-testid="export-keys" (click)="exportJson()">
                    {{ 'settings.keybindingsSection.exportJSON' | transloco }}
                  </button>
                  <button type="button" class="btn btn-sm" data-testid="import-keys" (click)="fileInput.click()">
                    {{ 'settings.keybindingsSection.importJSON' | transloco }}
                  </button>
                  <input
                    #fileInput
                    type="file"
                    accept="application/json,.json"
                    hidden
                    data-testid="import-file"
                    (change)="onFile($event)"
                  />
                </div>
              </div>
            </section>
          </pk-tab-panel>
        }
      </pk-tabs>
    </div>
  `,
})
export class KeybindingsSection {
  protected readonly tab = signal('pi-kit');
  protected readonly query = signal('');
  private readonly filterWords = computed(() => this.query().toLowerCase().trim().split(/\s+/).filter(Boolean));
  protected readonly i18n = inject(Language);
  private readonly isMac = inject(IS_MAC);
  protected readonly store = inject(SettingsStore);

  constructor() {
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', this.onRecord, true));
  }

  protected get storageKit() {
    return this.i18n.t('settings.keybindingsSection.piKitDatabase');
  }
  protected readonly recording = signal<Target | undefined>(undefined);
  protected readonly clash = signal<Clash | undefined>(undefined);
  protected readonly message = signal<string | undefined>(undefined);
  protected readonly messageWarn = signal(false);

  protected readonly kitRows = computed(() => {
    const combos = this.store.kitCombos();
    return kitShortcuts(this.i18n.t)
      .map((s) => ({
        id: s.id,
        label: s.label,
        combo: combos[s.id] ?? s.default,
        display: formatCombo(combos[s.id] ?? s.default, this.isMac),
        custom: (combos[s.id] ?? s.default) !== s.default,
      }))
      .filter((row) => this.matchesFilter(row.id, row.label, row.combo, row.display));
  });
  private readonly allFixedRows = fixedShortcuts(this.i18n.t).map((s) => ({
    id: s.id,
    label: s.label,
    display: s.keys.map((k) => formatCombo(k, this.isMac)).join(' '),
  }));

  protected readonly fixedRows = computed(() =>
    this.allFixedRows.filter((row) => this.matchesFilter(row.id, row.label, row.display)),
  );

  private matchesFilter(...parts: string[]): boolean {
    const text = parts.join(' ').toLowerCase();
    return this.filterWords().every((word) => text.includes(word));
  }

  /** pi’s actions; while searching, the ones whose description or id has the words (all of them if none has). */
  protected readonly piRows = computed(() => {
    const all = this.store.piBindings();
    const words = this.store.search().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all.filter((row) => this.matchesFilter(row.id, row.description, ...row.keys));
    const hit = all.filter((b) =>
      words.every((w) => `${b.description} ${b.id} ${b.keys.join(' ')}`.toLowerCase().includes(w)),
    );
    const rows = hit.length > 0 || !this.store.shows('keys-pi') ? hit : all;
    return rows.filter((row) => this.matchesFilter(row.id, row.description, ...row.keys));
  });

  protected isRecording(scope: Scope, id: string): boolean {
    const r = this.recording();
    return r?.scope === scope && r.id === id;
  }

  protected record(scope: Scope, id: string): void {
    this.clash.set(undefined);
    this.recording.set({ scope, id });
    // A capture listener on the window gets the key before any other handler of the app (the palette's ⌘K, ⌘N), whatever has the focus.
    window.addEventListener('keydown', this.onRecord, true);
  }

  protected stopRecording(): void {
    window.removeEventListener('keydown', this.onRecord, true);
    this.recording.set(undefined);
  }

  private readonly onRecord = (event: KeyboardEvent): void => {
    const target = this.recording();
    if (!target) return;
    // The key is the answer, not a shortcut: nothing else in the app may see it.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)
      return this.stopRecording();
    const combo = comboFromEvent(event, target.scope);
    if (!combo) return;
    this.stopRecording();
    const others =
      target.scope === 'pi-kit'
        ? usedBy(shortcutBindings(this.i18n.t, this.store.kitCombos()), combo, target.id)
        : usedBy(this.store.piBindings(), combo, target.id);
    if (others.length > 0) this.clash.set({ ...target, combo, with: others });
    else void this.apply(target, combo);
  };

  protected useAnyway(): void {
    const pending = this.clash();
    this.clash.set(undefined);
    if (pending) void this.apply(pending, pending.combo);
  }

  private apply(target: Target, combo: string): Promise<unknown> {
    return target.scope === 'pi-kit'
      ? this.store.setShortcut(target.id, combo)
      : this.store.setPiKeys(target.id, [combo]);
  }

  protected clashSummary(): string {
    const pending = this.clash();
    if (!pending) return '';
    const names = pending.with.map((id) =>
      pending.scope === 'pi-kit'
        ? shortcutLabel(this.i18n.t, id)
        : (this.store.piBindings().find((b) => b.id === id)?.description ?? id),
    );
    return this.i18n.t('settings.keybindingsSection.isAlreadyUsedBy', {
      value1: pending.scope === 'pi-kit' ? formatCombo(pending.combo, this.isMac) : pending.combo,
      value2: names.join(', '),
    });
  }

  /** The line under a row whose key another action also has. */
  protected clashText(scope: Scope, id: string): string | undefined {
    const others = (scope === 'pi-kit' ? this.store.kitConflicts() : this.store.piConflicts()).get(id);
    if (!others?.length) return undefined;
    const names = others.map((o) =>
      scope === 'pi-kit'
        ? shortcutLabel(this.i18n.t, o)
        : (this.store.piBindings().find((b) => b.id === o)?.description ?? o),
    );
    return this.i18n.t('settings.keybindingsSection.sharesItsKeyWith', { value1: names.join(', ') });
  }

  protected exportJson(): void {
    const blob = new Blob([this.store.exportKeybindings()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pi-kit-keybindings.json';
    link.click();
    URL.revokeObjectURL(url);
    this.messageWarn.set(false);
    this.message.set(this.i18n.t('settings.keybindingsSection.exportedPiKitKeybindingsJson'));
  }

  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const result = await this.store.importKeybindings(await file.text());
    this.messageWarn.set(result.skipped.length > 0);
    this.message.set(
      this.i18n.t('settings.keybindingsSection.imported', {
        value1: result.applied,
        value2:
          result.applied === 1
            ? this.i18n.t('settings.keybindingsSection.shortcutNoun')
            : this.i18n.t('settings.keybindingsSection.shortcuts'),
        value3:
          result.skipped.length > 0
            ? this.i18n.t('settings.keybindingsSection.skipped', { value1: result.skipped.join(', ') })
            : '',
      }),
    );
  }
}
