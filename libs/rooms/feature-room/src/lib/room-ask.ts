import { Component, input, output, signal } from '@angular/core';
import { PkIcon } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { RoomTaskAnswer, RoomTaskQuestion } from '@pi-kit/protocol';

@Component({
  selector: 'pk-room-ask',
  imports: [PkIcon, TranslocoPipe],
  host: { class: 'pk-room-ask', role: 'group', '[attr.aria-label]': 'label()' },
  template: `
    @for (question of questions(); track question.id) {
      <div class="ask">
        <p class="ask-title">
          <pk-icon name="help-circle" />
          <span>{{ question.title }}</span>
          @if (question.tool) {
            <span class="ask-tool font-mono">{{ question.tool }}</span>
          }
        </p>
        @if (question.message) {
          <p class="ask-message">{{ question.message }}</p>
        }
        <div class="ask-actions">
          @switch (question.method) {
            @case ('confirm') {
              <button
                type="button"
                class="btn btn-primary btn-xs"
                data-testid="room-task-allow"
                [disabled]="busy()"
                (click)="answered.emit([{ id: question.id, confirmed: true }])"
              >
                {{ 'rooms.task.allow' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                data-testid="room-task-deny"
                [disabled]="busy()"
                (click)="answered.emit([{ id: question.id, confirmed: false }])"
              >
                {{ 'rooms.task.deny' | transloco }}
              </button>
            }
            @case ('select') {
              @for (option of question.options ?? []; track option) {
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  data-testid="room-task-option"
                  [disabled]="busy()"
                  (click)="answered.emit([{ id: question.id, value: option }])"
                >
                  {{ option }}
                </button>
              }
            }
            @default {
              <textarea
                class="textarea textarea-xs w-full"
                data-testid="room-task-reply"
                rows="2"
                [placeholder]="question.placeholder ?? ''"
                [value]="replies()[question.id] ?? ''"
                (input)="reply(question.id, $any($event.target).value)"
              ></textarea>
              <button
                type="button"
                class="btn btn-primary btn-xs"
                data-testid="room-task-send-reply"
                [disabled]="busy()"
                (click)="answered.emit([{ id: question.id, value: replies()[question.id] ?? '' }])"
              >
                {{ 'rooms.task.send' | transloco }}
              </button>
            }
          }
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-testid="room-task-skip"
            [disabled]="busy()"
            (click)="answered.emit([{ id: question.id, cancelled: true }])"
          >
            {{ 'rooms.task.skip' | transloco }}
          </button>
        </div>
      </div>
    }
  `,
})
export class RoomAsk {
  readonly questions = input.required<RoomTaskQuestion[]>();
  readonly busy = input(false);
  readonly label = input<string>();
  readonly answered = output<RoomTaskAnswer['answers']>();
  protected readonly replies = signal<Record<string, string>>({});

  protected reply(questionId: string, value: string): void {
    this.replies.update((replies) => ({ ...replies, [questionId]: value }));
  }
}
