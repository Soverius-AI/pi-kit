import { Component, computed, inject, input } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/data';
import { AgentLiveState } from '@pi-kit/chat/util';
import { ClockStore } from '@pi-kit/data-access';
import { PkToolList } from '@pi-kit/design-system';
import { Language } from '@pi-kit/i18n';

@Component({
  selector: 'pk-nested-tool-calls',
  imports: [PkToolList],
  host: { class: 'contents' },
  template: `
    @if (items().length) {
      <pk-tool-list [items]="items()" [nested]="true" />
    }
  `,
})
export class NestedToolCalls {
  readonly callId = input.required<string>();
  private readonly chat = inject(ChatStore);
  private readonly i18n = inject(Language);
  private readonly clock = inject(ClockStore);
  protected readonly items = computed(() => {
    const pin = this.chat.agentLive();
    const nested = pin.nested.get(this.callId());
    return nested ? AgentLiveState.items(this.i18n.t, nested, pin, this.clock.now()) : [];
  });
}
