import { computed, Directive, inject, input } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/data';

/**
 * The turn attributes of a generated-UI frame. CopilotKit's message view draws an `a2ui-surface` or
 * `mcp-apps` activity message as a sibling of the turn's other pieces, so the frame sits in a `<pk-turn>` that carries what every
 * piece of a turn carries: `data-turn` (the hover and graph-sync key), `data-after` (the user message the answer follows),
 * `data-cont` (spacing as a continuation of the turn) and `pk-hot` (the turn is under the pointer). The id is the activity
 * message's; `ChatStore.turns()` knows its place in the turn.
 *
 *     <pk-turn role="pi" [pkGenUiTurn]="messageId()"> ...the frame... </pk-turn>
 */
@Directive({
  selector: '[pkGenUiTurn]',
  host: {
    '[attr.data-turn]': 'turnKey()',
    '[attr.data-after]': 'piece()?.after ?? null',
    '[attr.data-cont]': "piece()?.cont === false ? null : 'turn'",
    '[class.pk-hot]': 'hot()',
  },
})
export class PkGenUiTurn {
  /** The id of the activity message the frame draws. */
  readonly messageId = input<string | undefined>(undefined, { alias: 'pkGenUiTurn' });

  private readonly chat = inject(ChatStore);
  private readonly piece = computed(() => {
    const id = this.messageId();
    return id ? this.chat.turns().pieces.get(id) : undefined;
  });
  protected readonly turnKey = computed(() => this.piece()?.after ?? this.piece()?.block ?? null);
  protected readonly hot = computed(() => this.turnKey() !== null && this.chat.hotTurn() === this.turnKey());
}
