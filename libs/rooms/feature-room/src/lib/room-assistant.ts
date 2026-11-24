import { Component, computed, inject, linkedSignal } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { RoomCommitment, RoomFact, RoomFolder } from '@pi-kit/protocol';
import { OpenRoomStore, RoomAssistantStore } from '@pi-kit/rooms/data';
import { RoomAssistantEditor, type AssistantEditorSelection } from './room-assistant-editor';

@Component({
  selector: 'pk-room-assistant',
  imports: [TranslocoPipe, RoomAssistantEditor],
  host: { 'data-testid': 'room-assistant' },
  template: `
    @if (store.error(); as error) {
      @if (!dialog()) {
        <p class="error" role="alert">{{ error }}</p>
      }
    }
    @if (store.status(); as status) {
      <section aria-labelledby="room-memory-heading" data-testid="room-memory-overview">
        <header>
          <h3 id="room-memory-heading">{{ 'rooms.assistant.memory' | transloco }}</h3>
          <span class="count">{{ status.memory.length + playbookMemory().length }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-testid="room-memory-review"
            [attr.aria-label]="'rooms.assistant.reviewMemory' | transloco"
            (click)="openManager('memory-list')"
          >
            {{ 'rooms.assistant.review' | transloco }}
          </button>
        </header>
        @for (fact of status.memory.slice(0, 3); track fact.key) {
          <button type="button" class="item" data-testid="room-memory-item" (click)="openMemory(fact)">
            <span class="preview">{{ fact.text }}</span>
          </button>
        }
        @for (
          entry of playbookMemory().slice(0, status.memory.length >= 3 ? 0 : 3 - status.memory.length);
          track entry.key
        ) {
          <button
            type="button"
            class="item"
            data-testid="room-playbook-memory-item"
            (click)="openManager('memory-list')"
          >
            <span class="preview">{{ entry.text }}</span
            ><small>{{ 'rooms.assistant.playbookMemory' | transloco }}</small>
          </button>
        }
        @if (status.memory.length + playbookMemory().length > 3) {
          <button type="button" class="more" (click)="openManager('memory-list')">
            {{ 'rooms.assistant.viewAll' | transloco }}
          </button>
        }
      </section>
      <section aria-labelledby="room-reminders-heading" data-testid="room-reminders-overview">
        <header>
          <h3 id="room-reminders-heading">{{ 'rooms.assistant.commitments' | transloco }}</h3>
          <span class="count">{{ reminders().length }}</span>
          <button type="button" class="btn btn-ghost btn-xs" data-testid="room-reminder-add" (click)="openReminder()">
            {{ 'rooms.assistant.add' | transloco }}
          </button>
        </header>
        @for (item of reminders().slice(0, 2); track item.id) {
          <button type="button" class="item" [attr.data-commitment]="item.id" (click)="openReminder(item)">
            <span class="preview">{{ item.title }}</span
            ><small>{{ when(item.dueAt, item.timezone) }}</small>
          </button>
        }
        @if (status.commitments.length) {
          <button type="button" class="more" (click)="openManager('reminder-list')">
            {{ 'rooms.assistant.viewAll' | transloco }}
          </button>
        }
      </section>
      <section aria-labelledby="room-folders-heading" data-testid="room-folders-overview">
        <header>
          <h3 id="room-folders-heading">{{ 'rooms.assistant.folders' | transloco }}</h3>
          <span class="count">{{ status.folders.length }}</span>
          <button type="button" class="btn btn-ghost btn-xs" data-testid="room-folder-add" (click)="openFolder()">
            {{ 'rooms.assistant.link' | transloco }}
          </button>
        </header>
        @for (folder of status.folders.slice(0, 3); track folder.id) {
          <button type="button" class="item" [attr.data-folder]="folder.id" (click)="openFolder(folder)">
            <span class="preview">{{ folder.alias }}</span
            ><small [class.text-warning]="!folder.available">{{
              folder.available ? folder.target : folder.reason
            }}</small>
          </button>
        }
        @if (status.folders.length > 3) {
          <button type="button" class="more" (click)="openManager('folder-list')">
            {{ 'rooms.assistant.viewAll' | transloco }}
          </button>
        }
      </section>
      <section aria-labelledby="room-proactive-heading" data-testid="room-proactive-overview">
        <header>
          <h3 id="room-proactive-heading">{{ 'rooms.assistant.proactive' | transloco }}</h3>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-testid="room-proactive-settings"
            (click)="openManager('policy')"
          >
            {{ 'rooms.assistant.settings' | transloco }}
          </button>
        </header>
        <p class="room-meta">
          {{ (status.policy.enabled ? 'rooms.assistant.on' : 'rooms.assistant.off') | transloco }}
          @if (status.policy.enabled && status.policy.quietStart && status.policy.quietEnd) {
            · {{ status.policy.quietStart }}–{{ status.policy.quietEnd }}
          }
        </p>
      </section>
      <section class="managers" data-testid="room-assistant-managers">
        <button type="button" class="item" data-testid="room-work-manager" (click)="openManager('work')">
          <span>{{ 'rooms.assistant.work' | transloco }}</span
          ><span class="count" [class.text-warning]="reviewCount()">{{ reviewCount() || status.work.length }}</span>
        </button>
      </section>
    } @else {
      <p class="room-meta" role="status">{{ 'rooms.assistant.loading' | transloco }}</p>
    }
    @if (dialog(); as selected) {
      <pk-room-assistant-editor [selection]="selected" (closed)="dialog.set(undefined)" (navigate)="navigate($event)" />
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      font-size: 12px;
    }
    section {
      border-bottom: 1px solid var(--color-base-300);
      padding: 10px 14px;
      min-width: 0;
    }
    header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
    }
    h3 {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
    }
    header button {
      margin-left: auto;
    }
    .count {
      color: var(--pk-muted);
      font-size: 11px;
      border-radius: 999px;
      background: var(--color-base-200);
      padding: 0 6px;
    }
    .item {
      width: 100%;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 7px 0;
      text-align: start;
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    .item:hover,
    .more:hover {
      color: var(--color-primary);
    }
    .preview {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    small,
    .room-meta {
      color: var(--pk-muted);
      font-size: 11px;
      line-height: 1.5;
      margin: 0;
      overflow-wrap: anywhere;
    }
    small {
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .room-meta {
      padding: 3px 0;
    }
    .error {
      margin: 10px 14px;
      overflow-wrap: anywhere;
      color: var(--color-error);
    }
    .more {
      padding: 5px 0;
      color: var(--pk-muted);
      background: transparent;
      border: 0;
      cursor: pointer;
      font-size: 11px;
    }
    .managers .item {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }
    button:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    @media (max-width: 767px) {
      button {
        min-height: 44px;
      }
    }
  `,
})
export class RoomAssistant {
  protected readonly store = inject(RoomAssistantStore);
  private readonly room = inject(OpenRoomStore);
  protected readonly playbookMemory = computed(() => this.room.memory().filter((entry) => entry.scope === 'playbook'));
  protected readonly dialog = linkedSignal<AssistantEditorSelection | undefined>(() => {
    this.store.context();
    return undefined;
  });
  protected readonly reminders = computed(
    () =>
      this.store
        .status()
        ?.commitments.filter((item) => item.state === 'open')
        .sort((a, b) => a.dueAt - b.dueAt) ?? [],
  );
  protected readonly reviewCount = computed(
    () => this.store.status()?.work.filter((item) => item.state === 'review' || item.state === 'failed').length ?? 0,
  );
  protected when(at: number, timezone?: string): string {
    return new Date(at).toLocaleString(undefined, timezone ? { timeZone: timezone } : {});
  }
  openManager(kind: 'memory-list' | 'reminder-list' | 'folder-list' | 'policy' | 'work'): void {
    this.navigate({ kind });
  }
  openWork(): void {
    this.openManager('work');
  }
  protected navigate(selection: AssistantEditorSelection): void {
    this.store.error.set(undefined);
    this.dialog.set(selection);
  }
  protected openMemory(fact: RoomFact): void {
    this.navigate({ kind: 'memory', fact });
  }
  protected openReminder(reminder?: RoomCommitment): void {
    this.navigate({ kind: 'reminder', reminder });
  }
  protected openFolder(folder?: RoomFolder): void {
    this.navigate({ kind: 'folder', folder });
  }
}
