import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { PkActivityRow } from '@pi-kit/design-system';
import { ToolRowBase } from './tool-row-base';

/**
 * A background agent's `ask`, in its transcript: the question, whom it asked (the main agent or the user), and, once it settled,
 * the answer with who gave it ("Answered by main agent: …", "Answered by the user: …"), shown without expanding so the reader sees it at once.
 */
@Component({
  selector: 'pk-ask-row',
  imports: [PkActivityRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', 'data-testid': 'ask-row' },
  template: `
    <pk-activity-row
      [tool]="'chat.askRow.question' | transloco"
      [state]="state()"
      [target]="question()"
      [sub]="(kind() === 'user' ? 'chat.askRow.toYou' : 'chat.askRow.toMainAgent') | transloco"
      [expandable]="choices().length > 0"
      [(expanded)]="open"
    >
      <span stat>{{ took() }}</span>
      @if (open() && choices().length) {
        <div class="pk-out t-sm">{{ choices().join(' · ') }}</div>
      }
      @if (result(); as r) {
        <p class="t-sm m-0 whitespace-pre-wrap break-words" data-testid="ask-answer">{{ r.content }}</p>
      } @else {
        <p class="t-xs muted m-0">{{ 'chat.askRow.waiting' | transloco }}</p>
      }
    </pk-activity-row>
  `,
})
export class AskRow extends ToolRowBase {
  protected readonly question = computed(() => this.str('question') ?? '');
  protected readonly kind = computed(() => this.str('kind') ?? 'main');
  protected readonly choices = computed(() => {
    const value = this.args()['choices'];
    return Array.isArray(value) ? value.map(String) : [];
  });
}
