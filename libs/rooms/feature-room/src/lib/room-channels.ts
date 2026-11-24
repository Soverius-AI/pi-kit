import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, computed, inject, linkedSignal } from '@angular/core';
import { PkIcon } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { RoomChannel } from '@pi-kit/protocol';
import { OpenRoomStore, RoomChannelsStore } from '@pi-kit/rooms/data';
import { RoomDialog } from './room-dialog';
import { RoomPhone } from './room-phone';

@Component({
  selector: 'pk-room-channels',
  imports: [PkIcon, TranslocoPipe, NgTemplateOutlet, RoomDialog, RoomPhone],
  host: { 'data-testid': 'room-channels' },
  template: `
    <section [attr.aria-label]="'rooms.channels.wizard.title' | transloco">
      <header class="group-head">
        <h3>{{ 'rooms.channels.wizard.title' | transloco }}</h3>
        @if (channels.existing().length) {
          <span class="count">{{ channels.existing().length }}</span>
        }
        <button type="button" class="btn btn-ghost btn-xs" data-testid="room-channel-add" (click)="open('choose')">
          <pk-icon name="plus" size="14" />{{ 'rooms.channels.wizard.add' | transloco }}
        </button>
      </header>
      <div class="channel-list">
        @for (provider of channels.existing(); track provider.channel) {
          <button
            type="button"
            class="channel-row"
            [attr.data-provider]="provider.channel"
            [attr.data-testid]="'room-channel-manage-' + provider.channel"
            (click)="open(provider.channel)"
          >
            <span class="channel-brand" aria-hidden="true"
              ><ng-container
                [ngTemplateOutlet]="providerLogo"
                [ngTemplateOutletContext]="{ $implicit: provider.channel }"
            /></span>
            <span class="channel-main">
              <strong>{{ 'rooms.channels.' + provider.channel + '.title' | transloco }}</strong>
              @if (provider.store.status(); as status) {
                <span class="channel-meta">{{
                  status.binding?.groupName || ('rooms.phone.state.' + status.connection | transloco)
                }}</span>
              }
            </span>
            <pk-icon name="chevron-right" size="14" />
            <span class="channel-meta row-detail">
              @if (provider.store.status()?.binding) {
                {{
                  (provider.store.status()?.verifiedAt
                    ? 'rooms.channels.wizard.manage'
                    : 'rooms.channels.wizard.needsTest'
                  ) | transloco
                }}
              } @else {
                {{ 'rooms.channels.wizard.continue' | transloco }}
              }
            </span>
            @if (provider.store.error() || provider.store.status()?.error) {
              <span class="text-error row-detail" role="alert">{{
                provider.store.error() ?? provider.store.status()?.error
              }}</span>
            }
          </button>
        } @empty {
          <p class="empty" role="status">
            {{ (channels.loading() ? 'rooms.phone.loading' : 'rooms.channels.wizard.empty') | transloco }}
          </p>
        }
      </div>
    </section>
    @if (dialogOpen()) {
      <pk-room-dialog
        data-testid="room-channel-dialog"
        [title]="dialogTitle() | transloco"
        [closeLabel]="'rooms.channels.wizard.done' | transloco"
        [busy]="channels.selected()?.store?.busy() ?? false"
        [error]="pendingAction() ? channels.selected()?.store?.error() : undefined"
        (closed)="dialogOpen.set(false)"
      >
        @if (channels.selected(); as selected) {
          @if (pendingAction(); as action) {
            <p class="action-hint" data-testid="room-channel-action-hint">
              {{ 'rooms.channels.wizard.' + (action === 'unlink' ? 'removeHint' : 'disconnectHint') | transloco }}
            </p>
          } @else {
            <pk-room-phone
              [channel]="selected.channel"
              [externalStore]="selected.store"
              [embedded]="true"
              [hideDestructiveActions]="true"
            />
          }
        } @else {
          <p class="choose-hint">{{ 'rooms.channels.wizard.choose' | transloco }}</p>
          <div class="providers" data-testid="room-channel-picker">
            @for (provider of channels.providers; track provider.channel) {
              <button
                type="button"
                class="provider"
                [attr.data-provider]="provider.channel"
                [attr.data-testid]="'room-channel-select-' + provider.channel"
                (click)="channels.show(provider.channel)"
              >
                <span class="provider-heading"
                  ><span class="channel-brand" aria-hidden="true"
                    ><ng-container
                      [ngTemplateOutlet]="providerLogo"
                      [ngTemplateOutletContext]="{ $implicit: provider.channel }"
                  /></span>
                  <strong>{{ 'rooms.channels.' + provider.channel + '.title' | transloco }}</strong></span
                >
                <span>{{ 'rooms.channels.wizard.provider.' + provider.channel | transloco }}</span>
              </button>
            }
          </div>
        }
        @if (channels.selected(); as selected) {
          <div roomDialogActions class="channel-actions">
            @if (pendingAction(); as action) {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                data-testid="room-channel-action-cancel"
                [disabled]="selected.store.busy()"
                (click)="pendingAction.set(undefined)"
              >
                {{ 'rooms.channels.wizard.cancel' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-error btn-sm"
                data-testid="room-channel-action-confirm"
                [disabled]="selected.store.busy()"
                (click)="confirmAction()"
              >
                {{ 'rooms.channels.wizard.' + (action === 'unlink' ? 'remove' : 'disconnect') | transloco }}
              </button>
            } @else {
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                data-testid="room-channel-back"
                [disabled]="selected.store.busy()"
                (click)="channels.show('choose')"
              >
                <pk-icon name="chevron-left" size="14" />{{ 'rooms.channels.wizard.back' | transloco }}
              </button>
              @if (selected.store.status()?.binding || selected.store.status()?.candidate || selected.store.command()) {
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="room-channel-remove"
                  [disabled]="selected.store.busy()"
                  (click)="pendingAction.set('unlink')"
                >
                  {{ 'rooms.channels.wizard.remove' | transloco }}
                </button>
              }
              @if (selected.store.status(); as status) {
                @if (status.connection !== 'disconnected') {
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    data-testid="room-channel-disconnect"
                    [disabled]="selected.store.busy()"
                    (click)="pendingAction.set('disconnect')"
                  >
                    {{ 'rooms.channels.wizard.disconnect' | transloco }}
                  </button>
                }
              }
            }
          </div>
        }
      </pk-room-dialog>
    }
    <ng-template #providerLogo let-provider>
      <img
        class="provider-logo"
        [src]="'brands/rooms/' + provider + '.svg'"
        alt=""
        aria-hidden="true"
        width="28"
        height="28"
        [attr.data-provider-logo]="provider"
      />
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      width: 100%;
      border-bottom: 1px solid var(--color-base-300);
    }
    .group-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px 4px;
    }
    h3 {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
    }
    .group-head > button {
      margin-left: auto;
      min-height: 28px;
      height: auto;
      white-space: normal;
    }
    .count {
      font-size: 10px;
      color: var(--pk-muted);
      padding: 0 5px;
      border-radius: 8px;
      background: var(--color-base-200);
    }
    .channel-list {
      padding: 0 8px 6px;
    }
    .channel-row {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) auto;
      align-items: center;
      gap: 2px 6px;
      min-width: 0;
      width: 100%;
      min-height: 28px;
      padding: 6px;
      border: 0;
      text-align: start;
      border-radius: 5px;
      background: color-mix(in oklab, var(--channel-color) 3%, var(--color-base-100));
      cursor: pointer;
    }
    .channel-row:hover,
    .provider:hover {
      background: color-mix(in oklab, var(--channel-color) 12%, var(--color-base-100));
    }
    .channel-main {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }
    .channel-main strong {
      flex: none;
      font-size: 12px;
      font-weight: 500;
    }
    .channel-main .channel-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-detail {
      grid-column: 2 / 3;
      overflow-wrap: anywhere;
    }
    .channel-meta,
    .row-detail,
    .empty {
      font-size: 11px;
      line-height: 1.4;
    }
    .channel-meta,
    .empty,
    .choose-hint {
      color: var(--pk-muted);
    }
    .empty {
      margin: 0;
      padding: 4px 6px;
    }
    .channel-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 4px;
      min-width: 0;
    }
    .channel-actions button {
      white-space: normal;
      height: auto;
      min-height: 32px;
    }
    .action-hint {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .choose-hint {
      margin: 0 0 12px;
      font-size: 13px;
    }
    .providers {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .provider {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      min-width: 0;
      min-height: 72px;
      padding: 12px;
      text-align: start;
      border: 1px solid color-mix(in oklab, var(--channel-color) 35%, var(--color-base-300));
      border-radius: 8px;
      background: color-mix(in oklab, var(--channel-color) 6%, var(--color-base-100));
      cursor: pointer;
      overflow-wrap: anywhere;
    }
    .provider strong {
      font-size: 13px;
    }
    .provider > span:not(.provider-heading) {
      font-size: 12px;
      line-height: 1.4;
      color: var(--pk-muted);
    }
    [data-provider='whatsapp'] {
      --channel-color: #25d366;
    }
    [data-provider='telegram'] {
      --channel-color: #26a5e4;
    }
    [data-provider='signal'] {
      --channel-color: #3a76f0;
    }
    [data-provider='slack'] {
      --channel-color: #b440a9;
    }
    .provider-heading {
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .channel-brand {
      display: inline-flex;
      flex: none;
      width: 28px;
      height: 28px;
      align-items: center;
      justify-content: center;
    }
    .channel-row > .channel-brand {
      grid-column: 1;
      grid-row: 1 / span 2;
    }
    .channel-row > pk-icon {
      grid-column: 3;
      grid-row: 1 / span 2;
      color: var(--pk-muted);
    }
    .provider .channel-brand {
      width: 30px;
      height: 30px;
    }
    .provider-logo {
      display: block;
      width: 100%;
      height: 100%;
      flex: none;
    }
    .channel-list {
      display: grid;
      gap: 3px;
    }
    .channel-row:focus-visible,
    .provider:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    @media (pointer: coarse) {
      .channel-row,
      .group-head > button {
        min-height: 44px;
      }
    }
  `,
})
export class RoomChannels {
  protected readonly channels = inject(RoomChannelsStore);
  private readonly room = inject(OpenRoomStore);
  private readonly context = computed(() => {
    const room = this.room.room();
    return room ? JSON.stringify([room.hostInstanceId, room.id]) : undefined;
  });
  protected readonly dialogOpen = linkedSignal({ source: this.context, computation: () => false });
  protected readonly pendingAction = linkedSignal({
    source: computed(() => [this.context(), this.dialogOpen(), this.channels.screen()] as const),
    computation: () => undefined as 'unlink' | 'disconnect' | undefined,
  });
  protected async confirmAction(): Promise<void> {
    const provider = this.channels.selected();
    const action = this.pendingAction();
    const context = this.context();
    if (!provider || !action || provider.store.busy()) return;
    await provider.store.act(action);
    if (this.context() === context && this.channels.selected() === provider && !provider.store.error()) {
      this.pendingAction.set(undefined);
    }
  }
  protected readonly dialogTitle = computed(() => {
    const selected = this.channels.selected();
    const action = this.pendingAction();
    if (action) return `rooms.channels.wizard.${action === 'unlink' ? 'remove' : 'disconnect'}`;
    return selected ? `rooms.channels.${selected.channel}.title` : 'rooms.channels.wizard.add';
  });
  protected open(screen: 'choose' | RoomChannel): void {
    if (!this.context()) return;
    this.channels.show(screen);
    this.dialogOpen.set(true);
  }
  constructor() {
    for (const { store } of this.channels.providers) store.visible.set(true);
    inject(DestroyRef).onDestroy(() => {
      for (const { store } of this.channels.providers) store.visible.set(false);
    });
  }
}
