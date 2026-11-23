import { Component, effect, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { TranslocoPipe } from '@pi-kit/i18n';
import { RoomPhoneStore } from '@pi-kit/rooms/data';
import { toDataURL } from 'qrcode';

@Component({
  selector: 'pk-room-phone',
  imports: [TranslocoPipe, FormField],
  providers: [RoomPhoneStore],
  template: `
    <details (toggle)="phone.visible.set($any($event.target).open)" data-testid="room-phone">
      <summary>{{ 'rooms.phone.title' | transloco }}</summary>
      <div class="body">
        <p>{{ 'rooms.phone.experimental' | transloco }}</p>
        @if (phone.error(); as error) {
          <p role="alert">{{ error }}</p>
        }
        @if (phone.status(); as status) {
          <p role="status">{{ 'rooms.phone.state.' + status.connection | transloco }}</p>
          @if (status.error) {
            <p role="alert">{{ status.error }}</p>
          }
          @if (qr(); as image) {
            <img [src]="image" [alt]="'rooms.phone.qrAlt' | transloco" width="240" height="240" />
            <p>{{ 'rooms.phone.scan' | transloco }}</p>
          }
          @if (qrFailed()) {
            <p role="alert">{{ 'rooms.phone.qrFailed' | transloco }}</p>
          }
          @if (status.connection !== 'connected') {
            <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('connect')">
              {{ 'rooms.phone.connect' | transloco }}
            </button>
          }
          @if (status.binding; as binding) {
            <p>
              <strong>{{ binding.groupName || binding.group }}</strong>
            </p>
            <p>
              {{ 'rooms.phone.owner' | transloco }}: {{ binding.senderName }}
              <span class="identity">{{ binding.sender }}</span>
            </p>
            <p>{{ 'rooms.phone.delivery' | transloco }}</p>
            <p role="status">
              {{ (status.verifiedAt ? 'rooms.phone.verified' : 'rooms.phone.unverified') | transloco }}
            </p>
            <button
              type="button"
              class="btn btn-sm"
              data-testid="room-phone-test"
              [disabled]="phone.busy() || status.connection !== 'connected'"
              (click)="phone.act('test')"
            >
              {{ 'rooms.phone.test' | transloco }}
            </button>
            <form (submit)="saveUrl($event)">
              <label
                >{{ 'rooms.phone.appUrl' | transloco
                }}<input type="url" [formField]="linkFields.appUrl" data-testid="room-phone-app-url"
              /></label>
              <p>{{ 'rooms.phone.appUrlHint' | transloco }}</p>
              <button type="submit" class="btn btn-sm" [disabled]="phone.busy()">
                {{ 'rooms.phone.saveUrl' | transloco }}
              </button>
            </form>
            @if (status.pendingDeliveries) {
              <p>{{ 'rooms.phone.pendingDelivery' | transloco: { count: status.pendingDeliveries } }}</p>
            }
            @if (status.lastDelivery?.deliveredAt; as at) {
              <p>{{ 'rooms.phone.delivered' | transloco: { time: when(at) } }}</p>
            }
            <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('unlink')">
              {{ 'rooms.phone.unlink' | transloco }}
            </button>
          } @else if (status.connection === 'connected') {
            <p>{{ 'rooms.phone.groupHint' | transloco }}</p>
            <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('begin')">
              {{ 'rooms.phone.begin' | transloco }}
            </button>
            @if (phone.command(); as command) {
              <code data-testid="room-phone-command">{{ command }}</code>
              <p>{{ 'rooms.phone.commandHint' | transloco }}</p>
            }
            @if (status.candidate; as candidate) {
              <p>
                {{ 'rooms.phone.candidate' | transloco }}: <strong>{{ candidate.groupName || candidate.group }}</strong>
              </p>
              <p>
                {{ candidate.senderName }} <span class="identity">{{ candidate.sender }}</span>
              </p>
              <p>{{ 'rooms.phone.confirmHint' | transloco }}</p>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-testid="room-phone-confirm"
                [disabled]="phone.busy()"
                (click)="phone.act('confirm')"
              >
                {{ 'rooms.phone.confirm' | transloco }}
              </button>
            }
          }
          @if (status.queued) {
            <p>{{ 'rooms.phone.queued' | transloco: { count: status.queued } }}</p>
          }
          @if (status.needsReview) {
            <p>{{ 'rooms.phone.review' | transloco: { count: status.needsReview } }}</p>
            @for (item of status.review; track item.direction + item.id) {
              <blockquote>{{ item.text }}</blockquote>
              <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('review', item)">
                {{ 'rooms.phone.reviewed' | transloco }}
              </button>
            }
          }
          @if (status.connection !== 'disconnected') {
            <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('disconnect')">
              {{ 'rooms.phone.disconnect' | transloco }}
            </button>
          }
        } @else {
          <p>{{ 'rooms.phone.loading' | transloco }}</p>
        }
      </div>
    </details>
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid var(--color-base-300);
    }
    summary {
      cursor: pointer;
      padding: 12px 14px;
      font-weight: 600;
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 0 14px 14px;
      min-width: 0;
    }
    p,
    blockquote {
      margin: 0;
      line-height: 1.5;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .identity {
      display: block;
      color: var(--pk-muted);
    }
    form,
    label {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    input {
      min-width: 0;
      width: 100%;
      padding: 8px;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
    }
    code {
      padding: 8px;
      background: var(--color-base-200);
      overflow-wrap: anywhere;
      user-select: all;
    }
    img {
      width: 100%;
      max-width: 240px;
      height: auto;
      align-self: center;
    }
    button {
      height: auto;
      min-height: 44px;
      white-space: normal;
    }
    blockquote {
      border-inline-start: 2px solid var(--color-warning);
      padding-inline-start: 8px;
      max-height: 120px;
      overflow: auto;
    }
  `,
})
export class RoomPhone {
  protected readonly phone = inject(RoomPhoneStore);
  protected readonly qr = signal<string | undefined>(undefined);
  protected readonly qrFailed = signal(false);
  protected readonly linkModel = signal({ appUrl: '' });
  protected readonly linkFields = form(this.linkModel);
  protected when(at: number): string {
    return new Date(at).toLocaleString();
  }
  protected async saveUrl(event: Event): Promise<void> {
    event.preventDefault();
    await this.phone.saveUrl(this.linkModel().appUrl.trim());
  }

  constructor() {
    let savedUrl: string | null | undefined;
    effect(() => {
      const value = this.phone.status()?.appUrl;
      if (value === undefined || value !== savedUrl) {
        savedUrl = value;
        this.linkModel.set({ appUrl: value ?? '' });
      }
    });
    effect((cleanup) => {
      const value = this.phone.status()?.qr;
      let current = true;
      cleanup(() => {
        current = false;
      });
      this.qr.set(undefined);
      this.qrFailed.set(false);
      if (value)
        void toDataURL(value, { width: 240, margin: 2 }).then(
          (image) => {
            if (current) this.qr.set(image);
          },
          () => {
            if (current) this.qrFailed.set(true);
          },
        );
    });
  }
}
