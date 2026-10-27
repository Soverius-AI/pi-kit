import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { PkTurn } from '@pi-kit/design-system';
import { type PiDialogAnswer, type PiDialogRequest, isPiInterruptReason } from '@pi-kit/protocol';
import { ClockStore } from '@pi-kit/data-access';
import { ChatStore, errorText } from '@pi-kit/chat/data';
import { ConfirmBlock, EditorBlock, InputBlock, SelectBlock } from '@pi-kit/chat/ui';
import { ThreadsStore } from '@pi-kit/threads/api';

interface InterruptView {
  id: string;
  request: PiDialogRequest;
  /** "pi continues without an answer in 0:28" while the extension's timeout runs; undefined when it set none. */
  timeout: string | undefined;
  /** A background agent's question: it comes from the thread state, is answered through the agents, and never blocks pi. */
  agent?: boolean;
}

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * Extension dialogs as blocks in the transcript. pi is blocked in `ctx.ui.confirm / select /
 * input / editor`; the run ended with an interrupt and `injectInterrupt` (held by `ChatStore`) lists it. Each dialog kind is its own
 * block (`interrupt-blocks.ts`); an answer resumes the run, `{ confirmed }` for a confirm and `{ value }` for the others, and dismissing
 * resumes it as "cancelled", which pi's extension sees as `false` / `undefined`.
 *
 * pi's `timeout` option travels with the request. This host counts it down and, when it runs out, answers "cancelled" for the user,
 * which is what pi's own timeout returns.
 *
 * The questions of the thread's background agents for the user are drawn with the same blocks, marked as the agent's, from the
 * thread state the status channel keeps current; the answer goes to the agent through `ChatStore.answerAgentQuestion`, and the composer stays
 * usable meanwhile (they are not pi's interrupts). The backend's timer settles a timed one, so this host does not.
 */
@Component({
  selector: 'pk-interrupts',
  imports: [PkTurn, ConfirmBlock, SelectBlock, InputBlock, EditorBlock],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @for (item of views(); track item.id) {
      <pk-turn role="pi" [attr.data-testid]="item.agent ? 'agent-question-card' : null">
        @switch (item.request.method) {
          @case ('confirm') {
            <pk-confirm-block
              [request]="item.request"
              [timeout]="item.timeout"
              (answered)="answer(item, $event)"
              (dismissed)="dismiss(item)"
            />
          }
          @case ('select') {
            <pk-select-block
              [request]="item.request"
              [timeout]="item.timeout"
              (answered)="answer(item, $event)"
              (dismissed)="dismiss(item)"
            />
          }
          @case ('input') {
            <pk-input-block
              [request]="item.request"
              [timeout]="item.timeout"
              (answered)="answer(item, $event)"
              (dismissed)="dismiss(item)"
            />
          }
          @default {
            <pk-editor-block
              [request]="item.request"
              [timeout]="item.timeout"
              (answered)="answer(item, $event)"
              (dismissed)="dismiss(item)"
            />
          }
        }
      </pk-turn>
    }
    @if (error(); as message) {
      <p class="text-sm text-error pt-2" role="alert">{{ message }}</p>
    }
  `,
})
export class Interrupts {
  protected readonly i18n = inject(Language);
  private readonly session = inject(ChatStore);
  private readonly threads = inject(ThreadsStore);
  private readonly clock = inject(ClockStore);
  protected readonly error = signal<string | undefined>(undefined);
  /** Dialogs whose timeout already ended here, so each is dismissed once. */
  private readonly expired = new Set<string>();

  protected readonly views = computed<InterruptView[]>(() => {
    const now = this.clock.now();
    const timeoutOf = (request: PiDialogRequest): string | undefined =>
      request.expiresAt !== undefined
        ? this.i18n.t('chat.interrupts.piContinuesWithoutAnAnswerIn', { value1: clock(request.expiresAt - now) })
        : request.timeoutMs
          ? this.i18n.t('chat.interrupts.piWaitsForAnAnswer', { value1: clock(request.timeoutMs) })
          : undefined;
    const pi = this.session.interrupt
      .interrupts()
      .filter((i) => isPiInterruptReason(i.reason))
      .map((i) => {
        const request = (i.metadata ?? { method: 'confirm', title: i.message ?? 'Continue?' }) as PiDialogRequest;
        return { id: i.id, request, timeout: timeoutOf(request) };
      });
    const agents = (this.threads.selected()?.state.agentQuestions ?? []).map((q) => ({
      id: q.id,
      request: q.request,
      timeout: timeoutOf(q.request),
      agent: true,
    }));
    return [...pi, ...agents];
  });

  constructor() {
    effect(() => {
      const now = this.clock.now();
      for (const view of this.views()) {
        const { expiresAt } = view.request;
        if (view.agent || expiresAt === undefined || now < expiresAt || this.expired.has(view.id)) continue;
        this.expired.add(view.id);
        untracked(() => {
          this.session.say(
            'info',
            this.i18n.t('chat.interrupts.timedOutPiWentOnWithoutAn', { value1: view.request.title }),
          );
          void this.dismiss(view);
        });
      }
    });
  }

  protected async answer(item: InterruptView, payload: PiDialogAnswer): Promise<void> {
    this.error.set(undefined);
    try {
      if (item.agent) await this.session.answerAgentQuestion(item.id, payload);
      else await this.session.interrupt.resolve(payload, item.id);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  protected async dismiss(item: InterruptView): Promise<void> {
    this.error.set(undefined);
    try {
      if (item.agent) await this.session.answerAgentQuestion(item.id, 'cancelled');
      else await this.session.interrupt.cancel(item.id);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
