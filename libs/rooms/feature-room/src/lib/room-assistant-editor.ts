import { Component, DestroyRef, computed, inject, input, linkedSignal, output, viewChild } from '@angular/core';
import { disabled, form, FormField, max, maxLength, min, pattern, required } from '@angular/forms/signals';
import { isLocalExecution, WORKBENCH } from '@pi-kit/api';
import { PkIcon } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { RoomCommitment, RoomFact, RoomFolder } from '@pi-kit/protocol';
import { OpenRoomStore, RoomAssistantStore } from '@pi-kit/rooms/data';
import { RoomDialog } from './room-dialog';
import { RoomFolderPicker } from './room-folder-picker';

export type AssistantEditorSelection =
  | { kind: 'memory'; fact: RoomFact }
  | { kind: 'folder'; folder?: RoomFolder }
  | { kind: 'reminder'; reminder?: RoomCommitment }
  | { kind: 'memory-list' | 'folder-list' | 'reminder-list' | 'policy' | 'work' };

@Component({
  selector: 'pk-room-assistant-editor',
  imports: [RoomDialog, RoomFolderPicker, FormField, PkIcon, TranslocoPipe],
  template: `
    <pk-room-dialog
      [title]="title() | transloco"
      [closeLabel]="(browsing() ? 'rooms.assistant.cancel' : 'rooms.assistant.close') | transloco"
      [busy]="store.busy()"
      [error]="browsing() ? undefined : localError() || store.error()"
      (closed)="dismiss()"
    >
      @if (browsing()) {
        <pk-room-folder-picker
          [owner]="store.context()?.host ?? ''"
          [contextKey]="pickerContext()"
          [initialPath]="folderDraft().target"
          (selected)="applyPickedFolder($event)"
        />
      } @else {
        @switch (selection().kind) {
          @case ('memory') {
            <form id="room-memory-form" (submit)="saveMemory($event)">
              <label
                >{{ 'rooms.assistant.fact' | transloco
                }}<textarea [formField]="facts.text" rows="5" data-testid="room-memory-text"></textarea>
              </label>
            </form>
          }
          @case ('memory-list') {
            @for (fact of store.status()?.memory ?? []; track fact.key) {
              <button
                type="button"
                class="entry"
                data-testid="room-memory-entry"
                (click)="navigate.emit({ kind: 'memory', fact })"
              >
                <span class="pre">{{ fact.text }}</span
                ><span class="muted">{{ 'rooms.assistant.edit' | transloco }}</span>
              </button>
            }
            @for (entry of playbookMemory(); track entry.key) {
              <article data-testid="room-playbook-memory">
                <p class="pre">{{ entry.text }}</p>
                <span class="muted">{{ 'rooms.assistant.playbookMemory' | transloco }}</span>
              </article>
            }
            @if (!(store.status()?.memory?.length || playbookMemory().length)) {
              <p class="muted">{{ 'rooms.assistant.noMemory' | transloco }}</p>
            }
          }
          @case ('reminder') {
            @if (reminder(); as item) {
              <h3>{{ item.title }}</h3>
              <p>{{ when(item.dueAt, item.timezone) }}</p>
              @if (item.dailyAt) {
                <p>{{ 'rooms.assistant.dailyAt' | transloco: { time: item.dailyAt } }}</p>
              }
              @if (item.details) {
                <p class="pre">{{ item.details }}</p>
              }
              <p class="muted">{{ 'rooms.assistant.commitmentState.' + item.state | transloco }}</p>
              @if (item.state === 'open') {
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-sm"
                    [disabled]="store.busy()"
                    (click)="changeReminder(item, 'done')"
                  >
                    {{ 'rooms.assistant.done' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    [disabled]="store.busy()"
                    (click)="changeReminder(item, 'snooze')"
                  >
                    {{ 'rooms.assistant.snooze' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    [disabled]="store.busy()"
                    (click)="changeReminder(item, 'cancelled')"
                  >
                    {{ 'rooms.assistant.cancelReminder' | transloco }}
                  </button>
                </div>
              }
            } @else {
              <form id="room-reminder-form" (submit)="saveReminder($event)">
                <label
                  >{{ 'rooms.assistant.task' | transloco
                  }}<input [formField]="reminders.title" data-testid="room-commitment-title"
                /></label>
                <label
                  >{{ 'rooms.assistant.due' | transloco
                  }}<input type="datetime-local" [formField]="reminders.due" data-testid="room-commitment-due"
                /></label>
                <p class="muted">{{ 'rooms.assistant.timesIn' | transloco: { timezone: settings().timezone } }}</p>
                <label
                  >{{ 'rooms.assistant.daily' | transloco }}<input type="time" [formField]="reminders.daily"
                /></label>
                <label
                  >{{ 'rooms.assistant.details' | transloco
                  }}<textarea [formField]="reminders.details" rows="3"></textarea>
                </label>
              </form>
            }
          }
          @case ('reminder-list') {
            @for (item of store.status()?.commitments ?? []; track item.id) {
              <button
                type="button"
                class="entry"
                [attr.data-commitment]="item.id"
                (click)="navigate.emit({ kind: 'reminder', reminder: item })"
              >
                <strong>{{ item.title }}</strong
                ><span class="muted"
                  >{{ 'rooms.assistant.commitmentState.' + item.state | transloco }} ·
                  {{ when(item.dueAt, item.timezone) }}</span
                >
              </button>
            } @empty {
              <p class="muted">{{ 'rooms.assistant.noReminders' | transloco }}</p>
            }
          }
          @case ('folder') {
            @if (folder(); as linked) {
              <h3>{{ linked.alias }}</h3>
              <p class="path">{{ linked.target }}</p>
              <p [class.text-warning]="!linked.available">
                {{ linked.available ? ('rooms.assistant.readOnly' | transloco) : linked.reason }}
              </p>
              <p class="muted">{{ 'rooms.assistant.linkLocation' | transloco: { alias: linked.alias } }}</p>
              @if (confirmRemove()) {
                <p role="status">{{ 'rooms.assistant.removeFolderConfirm' | transloco }}</p>
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-error btn-sm"
                    [disabled]="store.busy()"
                    data-testid="room-folder-remove-confirm"
                    (click)="removeFolder(linked)"
                  >
                    {{ 'rooms.assistant.removeFolder' | transloco }}
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" (click)="confirmRemove.set(false)">
                    {{ 'rooms.assistant.cancel' | transloco }}
                  </button>
                </div>
              } @else {
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [disabled]="store.busy()"
                  data-testid="room-folder-remove"
                  (click)="confirmRemove.set(true)"
                >
                  {{ 'rooms.assistant.removeFolder' | transloco }}
                </button>
              }
            } @else {
              <form id="room-folder-form" (submit)="saveFolder($event)">
                <label
                  >{{ 'rooms.assistant.alias' | transloco
                  }}<input [formField]="folders.alias" data-testid="room-folder-alias"
                /></label>
                <div class="folder-path-field">
                  <label for="room-folder-target-input">{{ 'rooms.assistant.target' | transloco }}</label>
                  <div class="folder-target-control" data-testid="room-folder-path-control">
                    <input
                      id="room-folder-target-input"
                      [formField]="folders.target"
                      data-testid="room-folder-target"
                    />
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      [disabled]="store.busy()"
                      data-testid="room-folder-browse"
                      (click)="pickFolder()"
                    >
                      <pk-icon name="file-folder" size="16" />{{ 'rooms.assistant.browse' | transloco }}
                    </button>
                  </div>
                </div>
                <p class="muted">{{ 'rooms.assistant.folderAccess' | transloco }}</p>
              </form>
            }
          }
          @case ('folder-list') {
            @for (linked of store.status()?.folders ?? []; track linked.id) {
              <button type="button" class="entry" (click)="navigate.emit({ kind: 'folder', folder: linked })">
                <strong>{{ linked.alias }}</strong
                ><span class="path muted">{{ linked.target }}</span
                ><span [class.text-warning]="!linked.available">{{
                  linked.available ? ('rooms.assistant.readOnly' | transloco) : linked.reason
                }}</span>
              </button>
            } @empty {
              <p class="muted">{{ 'rooms.assistant.noFolders' | transloco }}</p>
            }
          }
          @case ('policy') {
            <form id="room-policy-form" (submit)="savePolicy($event)">
              <label class="check"
                ><input type="checkbox" [formField]="policy.enabled" data-testid="room-policy-enabled" />{{
                  'rooms.assistant.enable' | transloco
                }}</label
              >
              <label
                >{{ 'rooms.assistant.timezone' | transloco
                }}<input [formField]="policy.timezone" data-testid="room-policy-timezone"
              /></label>
              <div class="columns">
                <label
                  >{{ 'rooms.assistant.quietStart' | transloco
                  }}<input type="time" [formField]="policy.quietStart" data-testid="room-policy-quiet-start" /></label
                ><label
                  >{{ 'rooms.assistant.quietEnd' | transloco
                  }}<input type="time" [formField]="policy.quietEnd" data-testid="room-policy-quiet-end"
                /></label>
              </div>
              <p class="muted">{{ 'rooms.assistant.quietHelp' | transloco }}</p>
              <label
                >{{ 'rooms.assistant.dailyLimit' | transloco
                }}<input type="number" [formField]="policy.dailyLimit" data-testid="room-policy-daily-limit"
              /></label>
              <label class="check"
                ><input type="checkbox" [formField]="policy.limitRuns" data-testid="room-policy-limit-runs" />{{
                  'rooms.assistant.limitRuns' | transloco
                }}</label
              >
              @if (settings().limitRuns) {
                <label
                  >{{ 'rooms.assistant.runLimit' | transloco
                  }}<input type="number" [formField]="policy.dailyRunLimit" data-testid="room-policy-run-limit"
                /></label>
              }
            </form>
          }
          @case ('work') {
            @for (item of store.status()?.work ?? []; track item.id) {
              <article [attr.data-work-id]="item.id">
                <strong>{{ item.title }}</strong>
                <p class="muted">{{ 'rooms.assistant.workState.' + item.state | transloco }}</p>
                @if (item.state === 'failed' || item.state === 'review') {
                  <p>{{ 'rooms.assistant.reviewBeforeRetry' | transloco }}</p>
                  <div class="actions">
                    <button
                      type="button"
                      class="btn btn-sm"
                      [disabled]="store.busy()"
                      (click)="store.work(item.id, true)"
                    >
                      {{ 'rooms.assistant.retry' | transloco }}</button
                    ><button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      [disabled]="store.busy()"
                      (click)="store.work(item.id, false)"
                    >
                      {{ 'rooms.assistant.dismiss' | transloco }}
                    </button>
                  </div>
                }
              </article>
            } @empty {
              <p class="muted">{{ 'rooms.assistant.noWork' | transloco }}</p>
            }
          }
        }
      }
      <div roomDialogActions class="actions footer-actions">
        @if (browsing()) {
          <button
            type="button"
            class="btn btn-primary btn-sm"
            data-testid="room-folder-picker-select"
            [disabled]="!picker()?.canSelect()"
            (click)="picker()?.choose()"
          >
            {{ 'rooms.assistant.folderPicker.select' | transloco }}
          </button>
        } @else {
          @if (memoryFact(); as fact) {
            @if (confirmForget()) {
              <span>{{ 'rooms.assistant.forgetConfirm' | transloco }}</span
              ><button
                type="button"
                class="btn btn-error btn-sm"
                [disabled]="store.busy()"
                data-testid="room-memory-forget-confirm"
                (click)="forget(fact)"
              >
                {{ 'rooms.assistant.forget' | transloco }}
              </button>
            } @else {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                [disabled]="store.busy()"
                data-testid="room-memory-forget"
                (click)="confirmForget.set(true)"
              >
                {{ 'rooms.assistant.forget' | transloco }}
              </button>
            }
          }
          @switch (selection().kind) {
            @case ('memory') {
              <button
                type="submit"
                form="room-memory-form"
                class="btn btn-primary btn-sm"
                data-testid="room-memory-save"
                [disabled]="store.busy() || facts().invalid()"
              >
                {{ 'rooms.assistant.remember' | transloco }}
              </button>
            }
            @case ('folder') {
              @if (!folder()) {
                <button
                  type="submit"
                  form="room-folder-form"
                  class="btn btn-primary btn-sm"
                  data-testid="room-folder-save"
                  [disabled]="store.busy() || folders().invalid()"
                >
                  {{ 'rooms.assistant.addFolder' | transloco }}
                </button>
              }
            }
            @case ('reminder') {
              @if (!reminder()) {
                <button
                  type="submit"
                  form="room-reminder-form"
                  class="btn btn-primary btn-sm"
                  data-testid="room-reminder-save"
                  [disabled]="store.busy() || reminders().invalid()"
                >
                  {{ 'rooms.assistant.addCommitment' | transloco }}
                </button>
              }
            }
            @case ('policy') {
              <button
                type="submit"
                form="room-policy-form"
                class="btn btn-primary btn-sm"
                data-testid="room-policy-save"
                [disabled]="store.busy() || policy().invalid()"
              >
                {{ 'rooms.assistant.save' | transloco }}
              </button>
            }
            @case ('folder-list') {
              <button type="button" class="btn btn-primary btn-sm" (click)="navigate.emit({ kind: 'folder' })">
                {{ 'rooms.assistant.addFolder' | transloco }}
              </button>
            }
            @case ('reminder-list') {
              <button type="button" class="btn btn-primary btn-sm" (click)="navigate.emit({ kind: 'reminder' })">
                {{ 'rooms.assistant.addCommitment' | transloco }}
              </button>
            }
          }
        }
      </div>
    </pk-room-dialog>
  `,
  styles: `
    form,
    label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    form {
      gap: 16px;
    }
    input,
    textarea {
      width: 100%;
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      background: var(--color-base-100);
    }
    .folder-path-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .folder-target-control {
      display: flex;
      align-items: stretch;
      min-width: 0;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      background: var(--color-base-100);
      overflow: hidden;
    }
    .folder-target-control input {
      flex: 1;
      width: 0;
      min-width: 0;
      border: 0;
      border-radius: 0;
    }
    .folder-target-control button {
      flex: none;
      gap: 6px;
      margin: 0;
      border: 0;
      border-left: 1px solid var(--color-base-300);
      border-radius: 0;
      white-space: nowrap;
    }
    .check {
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }
    .check input {
      width: 18px;
      height: 18px;
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .footer-actions {
      margin-left: auto;
      justify-content: flex-end;
    }
    p {
      line-height: 1.5;
      margin: 0 0 12px;
      overflow-wrap: anywhere;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 14px;
    }
    .muted {
      color: var(--pk-muted);
      font-size: 12px;
    }
    .path {
      overflow-wrap: anywhere;
    }
    .pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .entry {
      display: flex;
      flex-direction: column;
      gap: 5px;
      width: 100%;
      text-align: start;
      background: transparent;
      border: 0;
      border-bottom: 1px solid var(--color-base-300);
      padding: 12px 0;
      cursor: pointer;
    }
    article {
      padding: 12px 0;
      border-bottom: 1px solid var(--color-base-300);
    }
    button {
      min-height: 36px;
    }
    @media (max-width: 767px) {
      button {
        min-height: 44px;
      }
    }
  `,
})
export class RoomAssistantEditor {
  readonly selection = input<AssistantEditorSelection>({ kind: 'memory-list' });
  readonly closed = output<void>();
  readonly navigate = output<AssistantEditorSelection>();
  protected readonly store = inject(RoomAssistantStore);
  private readonly room = inject(OpenRoomStore);
  private readonly workbench = inject(WORKBENCH);
  private readonly destroy = inject(DestroyRef);
  private readonly language = inject(Language);
  protected readonly browsing = linkedSignal(() => {
    this.selection();
    return false;
  });
  protected readonly picker = viewChild(RoomFolderPicker);
  protected readonly pickerContext = computed(() => JSON.stringify(this.store.context()) ?? '');
  protected readonly localError = linkedSignal(() => {
    this.selection();
    return '';
  });
  protected readonly confirmRemove = linkedSignal(() => {
    this.selection();
    return false;
  });
  protected readonly confirmForget = linkedSignal(() => {
    this.selection();
    return false;
  });
  protected readonly memoryFact = computed(() => {
    const s = this.selection();
    return s.kind === 'memory' ? s.fact : undefined;
  });
  protected readonly folder = computed(() => {
    const s = this.selection();
    return s.kind === 'folder' ? s.folder : undefined;
  });
  protected readonly reminder = computed(() => {
    const s = this.selection();
    return s.kind === 'reminder' ? s.reminder : undefined;
  });
  protected readonly playbookMemory = computed(() => this.room.memory().filter((entry) => entry.scope === 'playbook'));
  protected readonly title = computed(() => {
    if (this.browsing()) return 'rooms.assistant.folderPicker.title';
    switch (this.selection().kind) {
      case 'memory':
        return 'rooms.assistant.editMemory';
      case 'folder':
        return this.folder() ? 'rooms.assistant.folderDetails' : 'rooms.assistant.addFolder';
      case 'reminder':
        return this.reminder() ? 'rooms.assistant.reminderDetails' : 'rooms.assistant.addCommitment';
      case 'memory-list':
        return 'rooms.assistant.memory';
      case 'folder-list':
        return 'rooms.assistant.folders';
      case 'reminder-list':
        return 'rooms.assistant.commitments';
      case 'policy':
        return 'rooms.assistant.proactive';
      case 'work':
        return 'rooms.assistant.work';
    }
  });
  protected readonly fact = linkedSignal(() => {
    this.selection();
    return { text: this.memoryFact()?.text ?? '' };
  });
  protected readonly facts = form(this.fact, (path) => {
    disabled(path, () => this.store.busy());
    required(path.text);
    maxLength(path.text, 8000);
  });
  protected readonly reminderDraft = linkedSignal(() => {
    this.selection();
    return { title: '', details: '', due: '', daily: '' };
  });
  protected readonly reminders = form(this.reminderDraft, (path) => {
    disabled(path, () => this.store.busy());
    required(path.title);
    required(path.due);
    maxLength(path.title, 200);
    maxLength(path.details, 8000);
  });
  protected readonly folderDraft = linkedSignal(() => {
    this.selection();
    return { alias: '', target: '' };
  });
  protected readonly folders = form(this.folderDraft, (path) => {
    disabled(path, () => this.store.busy());
    required(path.alias);
    pattern(path.alias, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    required(path.target);
    maxLength(path.target, 4096);
  });
  private readonly roomPolicy = computed(() => this.store.status()?.policy, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  protected readonly settings = linkedSignal(() => {
    this.selection();
    const p = this.roomPolicy();
    return {
      enabled: p?.enabled ?? false,
      timezone: p?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      quietStart: p?.quietStart ?? '',
      quietEnd: p?.quietEnd ?? '',
      dailyLimit: p?.dailyLimit ?? 10,
      limitRuns: p?.dailyRunLimit !== undefined,
      dailyRunLimit: p?.dailyRunLimit ?? 20,
    };
  });
  protected readonly policy = form(this.settings, (path) => {
    const inactive = () => this.store.busy() || !this.settings().enabled;
    disabled(path.enabled, () => this.store.busy());
    disabled(path.timezone, inactive);
    disabled(path.quietStart, inactive);
    disabled(path.quietEnd, inactive);
    disabled(path.dailyLimit, inactive);
    disabled(path.limitRuns, inactive);
    disabled(path.dailyRunLimit, () => inactive() || !this.settings().limitRuns);
    required(path.timezone);
    maxLength(path.timezone, 100);
    min(path.dailyLimit, 1);
    max(path.dailyLimit, 100);
    min(path.dailyRunLimit, 1);
    max(path.dailyRunLimit, 100);
  });
  protected readonly canPickFolder = computed(
    () =>
      isLocalExecution() &&
      !this.workbench.remote &&
      !!this.workbench.entryId &&
      this.store.context()?.host === this.workbench.entryId &&
      typeof window.piKit?.showOpenDialog === 'function',
  );
  protected when(at: number, timezone?: string): string {
    return new Date(at).toLocaleString(undefined, timezone ? { timeZone: timezone } : {});
  }
  private current(selection: AssistantEditorSelection): boolean {
    return !this.destroy.destroyed && this.selection() === selection;
  }
  private async save(action: () => Promise<boolean>): Promise<void> {
    const selection = this.selection();
    this.localError.set('');
    if (await action()) {
      if (this.current(selection)) this.closed.emit();
    }
  }
  protected saveMemory(event: Event): void {
    event.preventDefault();
    const fact = this.memoryFact();
    if (fact && !this.facts().invalid())
      void this.save(() => this.store.memory({ key: fact.key, text: this.fact().text }));
  }
  protected forget(fact: RoomFact): void {
    void this.save(() => this.store.memory({ key: fact.key, text: '' }));
  }
  protected saveFolder(event: Event): void {
    event.preventDefault();
    if (!this.browsing() && !this.folders().invalid()) void this.save(() => this.store.folder(this.folderDraft()));
  }
  protected removeFolder(folder: RoomFolder): void {
    void this.save(() => this.store.removeFolder(folder.id));
  }
  protected dismiss(): void {
    if (this.browsing()) this.browsing.set(false);
    else this.closed.emit();
  }
  protected applyPickedFolder(path: string): void {
    this.folderDraft.update((draft) => ({
      ...draft,
      target: path,
      alias:
        draft.alias ||
        path
          .split(/[\\/]/)
          .filter(Boolean)
          .at(-1)
          ?.replace(/[^a-zA-Z0-9_-]/g, '-')
          .replace(/^[^a-zA-Z0-9]+/, '')
          .slice(0, 64) ||
        'folder',
    }));
    this.browsing.set(false);
  }
  protected async pickFolder(): Promise<void> {
    if (!this.canPickFolder()) {
      this.browsing.set(true);
      return;
    }
    const selection = this.selection();
    const context = this.store.context();
    try {
      const path = await window.piKit?.showOpenDialog?.();
      if (path && this.current(selection) && context === this.store.context()) this.applyPickedFolder(path);
    } catch {
      if (this.current(selection)) this.localError.set(this.language.t('rooms.assistant.pickerFailed'));
    }
  }
  protected saveReminder(event: Event): void {
    event.preventDefault();
    if (this.reminders().invalid()) return;
    const value = this.reminderDraft();
    const zone = this.settings().timezone;
    const due = inZone(value.due, zone);
    if (!Number.isFinite(due)) {
      this.localError.set(this.language.t('rooms.assistant.invalidDate'));
      return;
    }
    void this.save(() =>
      this.store.commitment({
        title: value.title,
        details: value.details,
        dueAt: due,
        timezone: zone,
        dailyAt: value.daily || null,
        source: 'owner',
      }),
    );
  }
  protected changeReminder(item: RoomCommitment, state: 'done' | 'cancelled' | 'snooze'): void {
    void this.save(() =>
      this.store.updateCommitment(
        item.id,
        state === 'snooze' ? { state: 'open', dueAt: Date.now() + 3600000 } : { state },
      ),
    );
  }
  protected savePolicy(event: Event): void {
    event.preventDefault();
    if (this.store.busy() || this.policy().invalid()) return;
    if (!this.settings().enabled) {
      const stored = this.roomPolicy();
      if (stored) void this.save(() => this.store.policy({ ...stored, enabled: false }));
      return;
    }
    const { limitRuns, dailyRunLimit, ...settings } = this.settings();
    void this.save(() =>
      this.store.policy({
        ...settings,
        dailyRunLimit: limitRuns ? dailyRunLimit : undefined,
        quietStart: settings.quietStart || null,
        quietEnd: settings.quietEnd || null,
      }),
    );
  }
}

function inZone(input: string, zone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) return Number.NaN;
  const values = match.slice(1).map(Number);
  const wanted = Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4]);
  let candidate = wanted;
  try {
    const local = (at: number) =>
      Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(at)
          .map((part) => [part.type, part.value]),
      );
    for (let i = 0; i < 3; i++) {
      const p = local(candidate);
      candidate += wanted - Date.UTC(+p['year'], +p['month'] - 1, +p['day'], +p['hour'], +p['minute']);
    }
    const p = local(candidate);
    return Date.UTC(+p['year'], +p['month'] - 1, +p['day'], +p['hour'], +p['minute']) === wanted
      ? candidate
      : Number.NaN;
  } catch {
    return Number.NaN;
  }
}
