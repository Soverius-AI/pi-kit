import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/api';
import { NewThreadStore } from '@pi-kit/threads/data';

/** The line under the well of a new thread: what Send will do. Nothing for any other thread. */
@Component({
  selector: 'pk-where-hint',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (text(); as hint) {
      <span class="pk-where-hint" data-testid="where-hint">{{ hint }}</span>
    }
  `,
})
export class WhereHint {
  private readonly store = inject(NewThreadStore);
  private readonly chat = inject(ChatStore);

  protected readonly text = computed(() => (this.chat.messages().length > 0 ? '' : (this.store.words()?.hint ?? '')));
}
