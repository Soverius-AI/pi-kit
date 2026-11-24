import { Component, ElementRef, afterRenderEffect, effect, inject, viewChild } from '@angular/core';
import { PkIcon } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import { RoomChannelsStore } from '@pi-kit/rooms/data';
import { RoomPhone } from './room-phone';

@Component({
  selector: 'pk-room-channels',
  imports: [PkIcon, TranslocoPipe, RoomPhone],
  host: { 'data-testid': 'room-channels' },
  template: `
    <section [attr.aria-label]="'rooms.channels.wizard.title' | transloco">
      <header>
        @if (channels.screen() !== 'list') {
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="room-channel-back"
            (click)="channels.show('list')"
          >
            <pk-icon name="chevron-left" size="14" />
            {{ 'rooms.channels.wizard.back' | transloco }}
          </button>
        }
        <h3 #heading tabindex="-1">
          {{
            (channels.selected()
              ? 'rooms.channels.' + channels.selected()!.channel + '.title'
              : channels.screen() === 'choose'
                ? 'rooms.channels.wizard.add'
                : 'rooms.channels.wizard.title'
            ) | transloco
          }}
        </h3>
        @if (channels.screen() === 'list') {
          <button
            type="button"
            class="btn btn-primary btn-sm"
            data-testid="room-channel-add"
            (click)="channels.show('choose')"
          >
            <pk-icon name="plus" size="14" />{{ 'rooms.channels.wizard.add' | transloco }}
          </button>
        }
      </header>
      @if (channels.selected(); as selected) {
        <pk-room-phone [channel]="selected.channel" [externalStore]="selected.store" [embedded]="true" />
        <footer>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="room-channel-done"
            (click)="channels.show('list')"
          >
            {{ 'rooms.channels.wizard.done' | transloco }}
          </button>
        </footer>
      } @else if (channels.screen() === 'choose') {
        <div class="body">
          <p>{{ 'rooms.channels.wizard.choose' | transloco }}</p>
          <div class="providers" data-testid="room-channel-picker">
            @for (provider of channels.providers; track provider.channel) {
              <button
                type="button"
                class="provider"
                [attr.data-testid]="'room-channel-select-' + provider.channel"
                (click)="channels.show(provider.channel)"
              >
                <strong>{{ 'rooms.channels.' + provider.channel + '.title' | transloco }}</strong>
                <span>{{ 'rooms.channels.wizard.provider.' + provider.channel | transloco }}</span>
              </button>
            }
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="room-channel-cancel"
            (click)="channels.show('list')"
          >
            {{ 'rooms.channels.wizard.cancel' | transloco }}
          </button>
        </div>
      } @else {
        <div class="body">
          @for (provider of channels.existing(); track provider.channel) {
            <button
              type="button"
              class="provider existing"
              [attr.data-testid]="'room-channel-manage-' + provider.channel"
              (click)="channels.show(provider.channel)"
            >
              <strong>{{ 'rooms.channels.' + provider.channel + '.title' | transloco }}</strong>
              @if (provider.store.status(); as status) {
                <span>{{ status.binding?.groupName ?? ('rooms.phone.state.' + status.connection | transloco) }}</span>
                @if (status.binding && !status.verifiedAt) {
                  <span>{{ 'rooms.channels.wizard.needsTest' | transloco }}</span>
                } @else if (!status.binding) {
                  <span>{{ 'rooms.channels.wizard.continue' | transloco }}</span>
                }
              }
              @if (provider.store.error() || provider.store.status()?.error) {
                <span class="text-error" role="alert">{{
                  provider.store.error() ?? provider.store.status()?.error
                }}</span>
              }
              <span class="action">{{ 'rooms.channels.wizard.manage' | transloco }} →</span>
            </button>
          } @empty {
            <p role="status">
              {{ (channels.loading() ? 'rooms.phone.loading' : 'rooms.channels.wizard.empty') | transloco }}
            </p>
          }
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      width: 100%;
      border-bottom: 1px solid var(--color-base-300);
    }
    section,
    header,
    .body,
    footer {
      min-width: 0;
    }
    header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 14px;
    }
    h3 {
      flex: 1;
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 0 14px 14px;
    }
    p {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-text-muted);
    }
    .providers {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .provider {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      min-width: 0;
      width: 100%;
      padding: 12px;
      text-align: start;
      border: 1px solid var(--color-base-300);
      border-radius: 8px;
      background: var(--color-base-100);
      cursor: pointer;
      overflow-wrap: anywhere;
    }
    .provider:hover {
      background: var(--color-base-200);
    }
    .provider:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .provider span {
      font-size: 12px;
      line-height: 1.5;
    }
    .action {
      color: var(--color-primary);
    }
    button {
      min-height: 44px;
      height: auto;
      white-space: normal;
    }
    footer {
      padding: 0 14px 14px;
    }
    footer button {
      width: 100%;
    }
  `,
})
export class RoomChannels {
  protected readonly channels = inject(RoomChannelsStore);
  private readonly heading = viewChild<ElementRef<HTMLHeadingElement>>('heading');
  constructor() {
    let previous = this.channels.screen();
    afterRenderEffect(() => {
      const screen = this.channels.screen();
      if (screen !== previous) {
        previous = screen;
        this.heading()?.nativeElement.focus();
      }
    });
    effect((cleanup) => {
      for (const { store } of this.channels.providers) store.visible.set(true);
      cleanup(() => {
        for (const { store } of this.channels.providers) store.visible.set(false);
      });
    });
  }
}
