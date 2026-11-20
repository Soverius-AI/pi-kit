import { Injectable } from '@nestjs/common';
import type { RoomTaskAnswer, RoomTaskQuestion } from '@pi-kit/protocol';
import type { PendingDialog } from '@pi-kit/pi-adapter';

export type WorkerAnswers = RoomTaskAnswer['answers'];

@Injectable()
export class RoomQuestions {
  private readonly waiting = new Map<string, (answers: WorkerAnswers | undefined) => void>();

  /** A title's first paragraph is the question; the rest is its detail, unless the dialog has a message of its own. */
  static fromDialogs(dialogs: readonly PendingDialog[]): RoomTaskQuestion[] {
    return dialogs.map(({ id, request }) => {
      const [title = '', ...rest] = request.title.split('\n\n');
      const message = request.message ?? (rest.length ? rest.join('\n\n') : undefined);
      return {
        id,
        method: request.method,
        title: title.slice(0, 2000),
        ...(message ? { message: message.slice(0, 8000) } : {}),
        ...(request.options ? { options: request.options.slice(0, 50) } : {}),
        ...(request.placeholder ? { placeholder: request.placeholder.slice(0, 500) } : {}),
        ...(request.tool ? { tool: request.tool } : {}),
      };
    });
  }

  static toResume(
    answers: WorkerAnswers,
  ): { interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown }[] {
    return answers.map((answer) =>
      answer.cancelled
        ? { interruptId: answer.id, status: 'cancelled' }
        : {
            interruptId: answer.id,
            status: 'resolved',
            payload: answer.confirmed !== undefined ? { confirmed: answer.confirmed } : { value: answer.value ?? '' },
          },
    );
  }

  ask(taskId: string): Promise<WorkerAnswers | undefined> {
    this.waiting.get(taskId)?.(undefined);
    return new Promise((resolve) => this.waiting.set(taskId, resolve));
  }

  answer(taskId: string, answers: WorkerAnswers): boolean {
    const resolve = this.waiting.get(taskId);
    if (!resolve) return false;
    this.waiting.delete(taskId);
    resolve(answers);
    return true;
  }

  cancel(taskId: string): void {
    const resolve = this.waiting.get(taskId);
    this.waiting.delete(taskId);
    resolve?.(undefined);
  }
}
