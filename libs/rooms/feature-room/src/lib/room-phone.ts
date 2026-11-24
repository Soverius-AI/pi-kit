import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { FormField, form, required, maxLength } from '@angular/forms/signals';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { RoomChannel } from '@pi-kit/protocol';
import { RoomPhoneStore } from '@pi-kit/rooms/data';
import { toDataURL } from 'qrcode';

@Component({
  selector: 'pk-room-phone',
  imports: [TranslocoPipe, FormField, NgTemplateOutlet, PkIcon, PkTip],
  providers: [RoomPhoneStore],
  template: `
    @if (embedded()) {
      <div data-testid="room-phone" [attr.data-channel]="channel()"><ng-container [ngTemplateOutlet]="setup" /></div>
    } @else {
      <details
        (toggle)="phone.visible.set($any($event.target).open)"
        data-testid="room-phone"
        [attr.data-channel]="channel()"
      >
        <summary>{{ profile() + '.title' | transloco }}</summary>
        <ng-container [ngTemplateOutlet]="setup" />
      </details>
    }
    <ng-template #setup>
      <div class="body">
        <p>{{ profile() + '.intro' | transloco }}</p>
        @if (phone.error(); as error) {
          <p role="alert">{{ error }}</p>
        }
        @if (phone.status(); as status) {
          <ol
            class="setup-steps"
            [attr.aria-label]="'rooms.phone.setupSteps' | transloco"
            data-testid="room-channel-steps"
          >
            @for (step of [1, 2, 3]; track step) {
              <li [attr.aria-current]="setupStep() === step ? 'step' : null">
                {{ 'rooms.phone.step' + step | transloco }}
              </li>
            }
          </ol>
          <p role="status">
            {{
              (status.connection === 'qr' ? profile() + '.qrState' : 'rooms.phone.state.' + status.connection)
                | transloco
            }}
          </p>
          @if (status.error) {
            <p role="alert">{{ status.error }}</p>
          }
          @if (status.identity; as identity) {
            <p data-testid="room-channel-identity">
              <strong>{{ identity.name }}</strong
              ><span class="identity">@{{ identity.username }}</span>
            </p>
            @if (channel() === 'telegram') {
              <p data-testid="room-telegram-talk">
                {{ 'rooms.channels.telegram.talk' | transloco: { username: identity.username } }}
              </p>
            }
          }
          @if (channel() === 'slack' || channel() === 'telegram') {
            <details [open]="!status.configured">
              <summary>{{ profile() + '.settings' | transloco }}</summary>
              <p>{{ profile() + '.setup' | transloco }}</p>
              <a [href]="credentialSetupUrl()" target="_blank" rel="noopener noreferrer">{{
                profile() + '.apps' | transloco
              }}</a>
              <form (submit)="saveCredentials($event)">
                @if (channel() === 'slack') {
                  <label
                    >{{ 'rooms.channels.slack.appToken' | transloco
                    }}<input
                      type="password"
                      autocomplete="off"
                      [formField]="credentialFields.appToken"
                      data-testid="room-slack-app-token"
                  /></label>
                }
                <label
                  >{{ profile() + '.botToken' | transloco
                  }}<input
                    type="password"
                    autocomplete="off"
                    [formField]="credentialFields.botToken"
                    [attr.data-testid]="'room-' + channel() + '-bot-token'"
                /></label>
                <button type="submit" class="btn btn-sm" [disabled]="phone.busy() || credentialFields().invalid()">
                  {{ profile() + '.save' | transloco }}
                </button>
              </form>
            </details>
          }
          @if (channel() === 'signal') {
            <p>{{ 'rooms.channels.signal.setup' | transloco }}</p>
            @if (status.dependency; as dependency) {
              @if (dependency.version) {
                <p>{{ 'rooms.channels.signal.version' | transloco: { version: dependency.version } }}</p>
              }
              @if (dependency.error) {
                <p role="alert">{{ dependency.error }}</p>
              }
            }
            <details>
              <summary>{{ 'rooms.channels.signal.settings' | transloco }}</summary>
              <form (submit)="saveSignalSettings($event)">
                <label
                  >{{ 'rooms.channels.signal.binaryPath' | transloco
                  }}<input [formField]="signalFields.binaryPath" spellcheck="false"
                /></label>
                <p>{{ 'rooms.channels.signal.binaryHint' | transloco }}</p>
                <button type="submit" class="btn btn-sm" [disabled]="phone.busy() || signalFields().invalid()">
                  {{ 'rooms.channels.signal.save' | transloco }}
                </button>
              </form>
            </details>
          }
          @if (status.input; as input) {
            <p>{{ 'rooms.phone.inputScope' | transloco }}</p>
            <p role="status" data-testid="room-phone-input">
              @if (input.lastGroupAt; as at) {
                {{ 'rooms.phone.groupInputSeen' | transloco: { time: when(at) } }}
              } @else {
                {{ 'rooms.phone.noGroupInput' | transloco }}
              }
            </p>
            @if (input.lastAcceptedAt; as at) {
              <p>{{ 'rooms.phone.inputAccepted' | transloco: { time: when(at) } }}</p>
            }
          }
          @if (qr(); as image) {
            <img [src]="image" [alt]="profile() + '.qrAlt' | transloco" width="240" height="240" />
            <p>{{ profile() + '.scan' | transloco }}</p>
          }
          @if (qrFailed()) {
            <p role="alert">{{ 'rooms.phone.qrFailed' | transloco }}</p>
          }
          @if (status.connection !== 'connected') {
            <button
              type="button"
              class="btn btn-sm"
              [disabled]="phone.busy() || ((channel() === 'slack' || channel() === 'telegram') && !status.configured)"
              (click)="phone.act('connect')"
            >
              {{ profile() + '.connect' | transloco }}
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
              <div class="app-url-label">
                <label [for]="appUrlInputId">{{ 'rooms.phone.appUrl' | transloco }}</label>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-square"
                  data-testid="room-phone-app-url-help"
                  [attr.aria-label]="'rooms.phone.appUrlHelp' | transloco"
                  [attr.aria-expanded]="appUrlHelp()"
                  [attr.aria-controls]="appUrlHelpId"
                  [pkTip]="'rooms.phone.appUrlHint' | transloco"
                  (click)="appUrlHelp.update((open) => !open)"
                >
                  <pk-icon name="help-circle" size="15" />
                </button>
              </div>
              <input [id]="appUrlInputId" type="url" [formField]="linkFields.appUrl" data-testid="room-phone-app-url" />
              @if (appUrlHelp()) {
                <p [id]="appUrlHelpId" data-testid="room-phone-app-url-explanation">
                  {{ 'rooms.phone.appUrlHint' | transloco }}
                </p>
              }
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
            @if (!hideDestructiveActions()) {
              <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('unlink')">
                {{ 'rooms.phone.unlink' | transloco }}
              </button>
            }
          } @else if (status.connection === 'connected') {
            <p>{{ profile() + '.groupHint' | transloco }}</p>
            <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('begin')">
              {{ 'rooms.phone.begin' | transloco }}
            </button>
            @if (phone.command(); as command) {
              @if (phone.groupLink(); as link) {
                <a
                  [href]="link"
                  class="btn btn-sm"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="room-telegram-add-group"
                  >{{ 'rooms.channels.telegram.addGroup' | transloco }}</a
                >
              }
              <code data-testid="room-phone-command">{{ command }}</code>
              <p>{{ 'rooms.phone.commandHint' | transloco }}</p>
            }
            @if (phone.commandExpired()) {
              <p role="alert" data-testid="room-phone-expired">{{ 'rooms.phone.codeExpired' | transloco }}</p>
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
          @if (!hideDestructiveActions() && status.connection !== 'disconnected') {
            <button type="button" class="btn btn-sm" [disabled]="phone.busy()" (click)="phone.act('disconnect')">
              {{ profile() + '.disconnect' | transloco }}
            </button>
          }
        } @else {
          <p>{{ 'rooms.phone.loading' | transloco }}</p>
        }
      </div>
    </ng-template>
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
    .app-url-label {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .app-url-label label {
      flex: 1;
    }
    .app-url-label button {
      flex: none;
      min-height: 32px;
      min-width: 32px;
    }
    @media (max-width: 767px) {
      .app-url-label button {
        min-height: 44px;
        min-width: 44px;
      }
    }
    .identity {
      display: block;
      color: var(--pk-muted);
    }
    .setup-steps {
      margin: 0;
      padding-inline-start: 20px;
      font-size: 12px;
      line-height: 1.7;
      color: var(--pk-muted);
    }
    .setup-steps [aria-current='step'] {
      color: var(--color-base-content);
      font-weight: 600;
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
  private static nextHelpId = 0;
  protected readonly appUrlHelpId = `room-phone-url-help-${++RoomPhone.nextHelpId}`;
  protected readonly appUrlInputId = `${this.appUrlHelpId}-input`;
  protected readonly appUrlHelp = linkedSignal(() => {
    this.channel();
    this.phone.context();
    return false;
  });
  readonly channel = input<RoomChannel>('whatsapp');
  readonly embedded = input(false);
  readonly hideDestructiveActions = input(false);
  readonly externalStore = input<RoomPhoneStore>();
  protected readonly profile = computed(() => `rooms.channels.${this.channel()}`);
  protected readonly credentialSetupUrl = computed(() =>
    this.channel() === 'telegram' ? 'https://t.me/BotFather' : 'https://api.slack.com/apps',
  );
  protected readonly credentials = signal({ appToken: '', botToken: '' });
  protected readonly credentialFields = form(this.credentials, (path) => {
    required(path.appToken, { when: () => this.channel() === 'slack' });
    required(path.botToken);
    maxLength(path.appToken, 8192);
    maxLength(path.botToken, 8192);
  });
  protected readonly signalSettings = signal({ binaryPath: '' });
  protected readonly signalFields = form(this.signalSettings, (path) => maxLength(path.binaryPath, 4096));
  private readonly localPhone = inject(RoomPhoneStore);
  protected get phone(): RoomPhoneStore {
    return this.externalStore() ?? this.localPhone;
  }
  protected readonly setupStep = computed(() => {
    const status = this.phone.status();
    if (status?.connection !== 'connected') return 1;
    if (!status.binding) return 2;
    return status.verifiedAt ? 0 : 3;
  });
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

  protected async saveCredentials(event: Event): Promise<void> {
    event.preventDefault();
    if (this.credentialFields().invalid()) return;
    const submitted = this.credentials();
    const values = this.channel() === 'telegram' ? { botToken: submitted.botToken } : submitted;
    if ((await this.phone.settings(values)) && this.credentials() === submitted)
      this.credentials.set({ appToken: '', botToken: '' });
  }
  protected async saveSignalSettings(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.signalFields().invalid())
      await this.phone.settings({ binaryPath: this.signalSettings().binaryPath.trim() });
  }

  constructor() {
    effect(() => {
      const channel = this.channel();
      this.phone.context();
      this.phone.channel.set(channel);
      this.credentials.set({ appToken: '', botToken: '' });
      this.signalSettings.set({ binaryPath: '' });
    });
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
