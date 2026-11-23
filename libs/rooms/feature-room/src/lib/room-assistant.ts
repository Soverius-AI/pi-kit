import { Component, effect, inject, signal } from '@angular/core';
import { form, FormField, required, maxLength, min, max, disabled, readonly } from '@angular/forms/signals';
import { TranslocoPipe, Language } from '@pi-kit/i18n';
import { RoomAssistantStore } from '@pi-kit/rooms/data';
import type { RoomCommitment } from '@pi-kit/protocol';

@Component({
  selector: 'pk-room-assistant',
  imports: [FormField, TranslocoPipe],
  providers: [RoomAssistantStore],
  template: `
    <details (toggle)="store.visible.set($any($event.target).open)" data-testid="room-assistant">
      <summary>{{ 'rooms.assistant.title' | transloco }}</summary>
      <div class="body">
        @if (store.error(); as error) {
          <p role="alert">{{ error }}</p>
        }
        @if (store.status(); as status) {
          <details open>
            <summary>{{ 'rooms.assistant.memory' | transloco }}</summary>
            <p>{{ 'rooms.assistant.memoryHint' | transloco }}</p>
            @for (fact of status.memory; track fact.key) {
              <article>
                <b>{{ fact.key }}</b>
                <p class="pre">{{ fact.text }}</p>
                <small>{{ fact.updatedBy }} · {{ when(fact.updatedAt) }}</small>
                <div class="actions">
                  <button type="button" [disabled]="store.busy()" (click)="editFact(fact.key, fact.text)">
                    {{ 'rooms.assistant.edit' | transloco }}</button
                  ><button type="button" [disabled]="store.busy()" (click)="forgetFact(fact.key)">
                    {{ 'rooms.assistant.forget' | transloco }}
                  </button>
                </div>
              </article>
            }
            <form (submit)="saveFact($event)">
              <label
                >{{ 'rooms.assistant.key' | transloco
                }}<input [formField]="facts.key" data-testid="room-memory-key" /></label
              ><label
                >{{ 'rooms.assistant.fact' | transloco
                }}<textarea [formField]="facts.text" rows="3" data-testid="room-memory-text"></textarea></label
              ><button type="submit" data-testid="room-memory-save" [disabled]="store.busy() || facts().invalid()">
                {{ 'rooms.assistant.remember' | transloco }}
              </button>
            </form>
          </details>
          <details open>
            <summary>{{ 'rooms.assistant.commitments' | transloco }}</summary>
            @for (item of status.commitments; track item.id) {
              <article [attr.data-commitment]="item.id">
                <b>{{ item.title }}</b>
                <p>
                  {{ 'rooms.assistant.commitmentState.' + item.state | transloco }} ·
                  {{ when(item.dueAt, item.timezone) }}
                </p>
                <small>{{ item.dailyAt || '' }} {{ item.timezone }} · {{ item.source }}</small>
                @if (item.state === 'open') {
                  <div class="actions">
                    <button
                      type="button"
                      [disabled]="store.busy()"
                      (click)="store.updateCommitment(item.id, { state: 'done' })"
                    >
                      {{ 'rooms.assistant.done' | transloco }}</button
                    ><button type="button" [disabled]="store.busy()" (click)="snooze(item)">
                      {{ 'rooms.assistant.snooze' | transloco }}</button
                    ><button
                      type="button"
                      [disabled]="store.busy()"
                      (click)="store.updateCommitment(item.id, { state: 'cancelled' })"
                    >
                      {{ 'rooms.assistant.cancel' | transloco }}
                    </button>
                  </div>
                }
              </article>
            }
            <form (submit)="createCommitment($event)">
              <label
                >{{ 'rooms.assistant.task' | transloco
                }}<input [formField]="commitments.title" data-testid="room-commitment-title" /></label
              ><label
                >{{ 'rooms.assistant.due' | transloco
                }}<input type="datetime-local" [formField]="commitments.due" /></label
              ><label
                >{{ 'rooms.assistant.daily' | transloco }}<input type="time" [formField]="commitments.daily" /></label
              ><label
                >{{ 'rooms.assistant.details' | transloco
                }}<textarea [formField]="commitments.details" rows="2"></textarea></label
              ><button type="submit" [disabled]="store.busy() || commitments().invalid()">
                {{ 'rooms.assistant.addCommitment' | transloco }}
              </button>
            </form>
          </details>
          <details>
            <summary>{{ 'rooms.assistant.proactive' | transloco }}</summary>
            <p>{{ 'rooms.assistant.proactiveHint' | transloco }}</p>
            <form (submit)="savePolicy($event)">
              <label class="check"
                ><input type="checkbox" [formField]="policy.enabled" />{{ 'rooms.assistant.enable' | transloco }}</label
              ><label>{{ 'rooms.assistant.timezone' | transloco }}<input [formField]="policy.timezone" /></label
              ><label
                >{{ 'rooms.assistant.quietStart' | transloco
                }}<input type="time" [formField]="policy.quietStart" /></label
              ><label
                >{{ 'rooms.assistant.quietEnd' | transloco }}<input type="time" [formField]="policy.quietEnd" /></label
              ><label
                >{{ 'rooms.assistant.dailyLimit' | transloco
                }}<input type="number" [formField]="policy.dailyLimit" /></label
              ><label
                >{{ 'rooms.assistant.runLimit' | transloco }}<input type="number" [formField]="policy.dailyRunLimit"
              /></label>
              <p>{{ 'rooms.assistant.runLimitHint' | transloco }}</p>
              <button type="submit" [disabled]="store.busy() || policy().invalid()">
                {{ 'rooms.assistant.save' | transloco }}
              </button>
            </form>
          </details>
          <details>
            <summary>{{ 'rooms.assistant.folders' | transloco }}</summary>
            <p>{{ 'rooms.assistant.folderHint' | transloco }}</p>
            <code>{{ status.workspace }}</code>
            @for (folder of status.folders; track folder.id) {
              <article>
                <b>folders/{{ folder.alias }}</b
                ><code>{{ folder.target }}</code>
                <p>{{ folder.available ? ('rooms.assistant.readOnly' | transloco) : folder.reason }}</p>
                <small>{{ folder.environmentId }}</small
                ><button type="button" [disabled]="store.busy()" (click)="store.removeFolder(folder.id)">
                  {{ 'rooms.assistant.removeFolder' | transloco }}
                </button>
              </article>
            }
            <form (submit)="addFolder($event)">
              <label>{{ 'rooms.assistant.alias' | transloco }}<input [formField]="folders.alias" /></label
              ><label>{{ 'rooms.assistant.target' | transloco }}<input [formField]="folders.target" /></label
              ><button type="submit" [disabled]="store.busy() || folders().invalid()">
                {{ 'rooms.assistant.addFolder' | transloco }}
              </button>
            </form>
          </details>
          <details>
            <summary>{{ 'rooms.assistant.files' | transloco }}</summary>
            @for (file of status.files ?? []; track file.path) {
              <button type="button" (click)="store.download(file.path)">{{ file.path }} · {{ file.size }} B</button>
            }
          </details>
          <details>
            <summary>{{ 'rooms.assistant.work' | transloco }}</summary>
            <p>{{ 'rooms.assistant.reviewHint' | transloco }}</p>
            @for (item of status.work; track item.id) {
              <article [attr.data-work-id]="item.id">
                <b>{{ item.title }}</b>
                <p>{{ 'rooms.assistant.workState.' + item.state | transloco }}</p>
                @if (item.state === 'failed' || item.state === 'review') {
                  <div class="actions">
                    <button type="button" [disabled]="store.busy()" (click)="store.work(item.id, true)">
                      {{ 'rooms.assistant.retry' | transloco }}</button
                    ><button type="button" [disabled]="store.busy()" (click)="store.work(item.id, false)">
                      {{ 'rooms.assistant.dismiss' | transloco }}
                    </button>
                  </div>
                }
              </article>
            }
          </details>
        } @else {
          <p>{{ 'rooms.assistant.loading' | transloco }}</p>
        }
      </div>
    </details>
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid var(--color-base-300);
      font-size: 12px;
    }
    summary {
      padding: 12px 14px;
      cursor: pointer;
      font-weight: 600;
    }
    .body {
      padding: 0 14px 14px;
      min-width: 0;
    }
    .body > details {
      border-top: 1px solid var(--color-base-300);
      padding-bottom: 10px;
    }
    .body > details > summary {
      padding: 12px 0;
    }
    article {
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      padding: 10px;
      margin: 10px 0;
    }
    p {
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .pre {
      white-space: pre-wrap;
    }
    small {
      display: block;
      color: var(--pk-muted);
      overflow-wrap: anywhere;
    }
    form,
    label {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    form {
      gap: 10px;
      margin-top: 12px;
    }
    input,
    textarea {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--color-base-300);
      padding: 8px;
      border-radius: 6px;
      background: var(--color-base-100);
    }
    .check {
      flex-direction: row;
      align-items: center;
    }
    .check input {
      width: 20px;
      height: 20px;
    }
    button {
      min-height: 44px;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      padding: 8px;
      margin-top: 6px;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    code {
      display: block;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      font-size: 11px;
    }
    button:disabled {
      opacity: 0.5;
    }
  `,
})
export class RoomAssistant {
  private readonly language = inject(Language);
  protected readonly store = inject(RoomAssistantStore);
  protected readonly fact = signal({ key: '', text: '' });
  protected readonly editingFactKey = signal<string | undefined>(undefined);
  protected readonly facts = form(this.fact, (path) => {
    disabled(path, () => this.store.busy());
    readonly(path.key, () => this.editingFactKey() !== undefined);
    required(path.key);
    required(path.text);
    maxLength(path.key, 80);
    maxLength(path.text, 8000);
  });
  protected readonly commitment = signal({ title: '', details: '', due: '', daily: '' });
  protected readonly commitments = form(this.commitment, (path) => {
    required(path.title);
    maxLength(path.title, 200);
    maxLength(path.details, 8000);
  });
  protected readonly folder = signal({ alias: '', target: '' });
  protected readonly folders = form(this.folder, (path) => {
    required(path.alias);
    required(path.target);
  });
  protected readonly settings = signal({
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    quietStart: '22:00',
    quietEnd: '08:00',
    dailyLimit: 10,
    dailyRunLimit: 20 as number | null,
  });
  protected readonly policy = form(this.settings, (path) => {
    min(path.dailyLimit, 1);
    max(path.dailyLimit, 100);
    min(path.dailyRunLimit, 1);
    max(path.dailyRunLimit, 100);
    required(path.timezone);
  });
  constructor() {
    effect(() => {
      this.store.roomId();
      this.editingFactKey.set(undefined);
      this.fact.set({ key: '', text: '' });
      this.commitment.set({ title: '', details: '', due: '', daily: '' });
      this.folder.set({ alias: '', target: '' });
    });
    let roomPolicy = '';
    effect(() => {
      const value = this.store.status()?.policy;
      if (!value) roomPolicy = '';
      if (value) {
        const key = JSON.stringify(value);
        if (key !== roomPolicy) {
          roomPolicy = key;
          this.settings.set({
            ...value,
            quietStart: value.quietStart ?? '',
            quietEnd: value.quietEnd ?? '',
            dailyRunLimit: value.dailyRunLimit ?? null,
          });
        }
      }
    });
  }
  protected when(at: number, timezone?: string): string {
    return new Date(at).toLocaleString(undefined, timezone ? { timeZone: timezone } : {});
  }
  protected editFact(key: string, text: string): void {
    this.editingFactKey.set(key);
    this.fact.set({ key, text });
  }
  protected async saveFact(event: Event): Promise<void> {
    event.preventDefault();
    const draft = this.fact();
    if (
      !this.facts().invalid() &&
      (await this.store.memory({ key: this.editingFactKey() ?? draft.key, text: draft.text }))
    ) {
      this.editingFactKey.set(undefined);
      this.fact.set({ key: '', text: '' });
    }
  }
  protected async forgetFact(key: string): Promise<void> {
    if ((await this.store.memory({ key, text: '' })) && this.editingFactKey() === key) {
      this.editingFactKey.set(undefined);
      this.fact.set({ key: '', text: '' });
    }
  }
  protected async createCommitment(event: Event): Promise<void> {
    event.preventDefault();
    if (this.commitments().invalid()) return;
    const value = this.commitment();
    const zone = this.settings().timezone;
    const due = inZone(value.due, zone);
    if (!Number.isFinite(due)) {
      this.store.error.set(this.language.t('rooms.assistant.invalidDate'));
      return;
    }
    if (
      await this.store.commitment({
        title: value.title,
        details: value.details,
        dueAt: due,
        timezone: zone,
        dailyAt: value.daily || null,
        source: 'owner',
      })
    )
      this.commitment.set({ title: '', details: '', due: '', daily: '' });
  }
  protected snooze(item: RoomCommitment): void {
    void this.store.updateCommitment(item.id, { state: 'open', dueAt: Date.now() + 3600000 });
  }
  protected async savePolicy(event: Event): Promise<void> {
    event.preventDefault();
    const value = this.settings();
    if (this.policy().invalid()) return;
    await this.store.policy({
      ...value,
      dailyRunLimit: value.dailyRunLimit ?? undefined,
      quietStart: value.quietStart || null,
      quietEnd: value.quietEnd || null,
    });
  }
  protected async addFolder(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.folders().invalid() && (await this.store.folder(this.folder())))
      this.folder.set({ alias: '', target: '' });
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
      const shown = Date.UTC(+p['year'], +p['month'] - 1, +p['day'], +p['hour'], +p['minute']);
      candidate += wanted - shown;
    }
    const p = local(candidate);
    return Date.UTC(+p['year'], +p['month'] - 1, +p['day'], +p['hour'], +p['minute']) === wanted
      ? candidate
      : Number.NaN;
  } catch {
    return Number.NaN;
  }
}
