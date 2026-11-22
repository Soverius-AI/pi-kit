import {
  Component,
  ViewContainerRef,
  effect,
  inject,
  input,
  inputBinding,
  output,
  outputBinding,
  viewChild,
} from '@angular/core';
import type { PiDialogAnswer, PiDialogRequest, RoomTaskAnswer, RoomTaskQuestion } from '@pi-kit/protocol';
import { ROOM_DIALOG } from '@pi-kit/rooms/data';

/** What a lead or a worker asks, drawn with the blocks a thread uses for the same questions. */
@Component({
  selector: 'pk-room-ask',
  host: { class: 'pk-room-ask', role: 'group', '[attr.aria-label]': 'label()', '[attr.aria-busy]': 'busy()' },
  template: `<ng-container #slot />`,
})
export class RoomAsk {
  readonly questions = input.required<RoomTaskQuestion[]>();
  readonly busy = input(false);
  readonly label = input<string>();
  readonly answered = output<RoomTaskAnswer['answers']>();
  private readonly loader = inject(ROOM_DIALOG, { optional: true });
  private readonly slot = viewChild.required('slot', { read: ViewContainerRef });

  constructor() {
    effect((onCleanup) => {
      const questions = this.questions();
      const slot = this.slot();
      let stale = false;
      onCleanup(() => (stale = true));
      void this.loader?.().then((block) => {
        if (stale) return;
        slot.clear();
        for (const question of questions)
          slot.createComponent(block, {
            bindings: [
              inputBinding('request', () => RoomAsk.request(question)),
              outputBinding<PiDialogAnswer>('answered', (answer) =>
                this.answered.emit([{ id: question.id, ...answer }]),
              ),
              outputBinding('dismissed', () => this.answered.emit([{ id: question.id, cancelled: true }])),
            ],
          });
      });
    });
  }

  private static request(question: RoomTaskQuestion): PiDialogRequest {
    return {
      method: question.method,
      title: question.title,
      ...(question.message ? { message: question.message } : {}),
      ...(question.options ? { options: question.options } : {}),
      ...(question.placeholder ? { placeholder: question.placeholder } : {}),
      ...(question.tool ? { tool: question.tool } : {}),
    };
  }
}
