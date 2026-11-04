import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import {
  EntryApiClient,
  errorMessage,
  isDeviceConnection,
  peersApprove,
  peersConnect,
  peersInvite,
  peersList,
  peersReject,
  peersRename,
  peersUnpair,
  unwrap,
} from '@pi-kit/api';
import { DialogStore, EnvironmentsStore } from '@pi-kit/data-access';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { PeerManager, PeerSummary } from '@pi-kit/protocol';

/** Pairing with other pi-kit instances: invitations out, invitations in, requests and the paired list. */
@Component({
  selector: 'pk-environment-peers-section',
  imports: [TranslocoPipe],
  template: `
    <section class="pk-group" data-testid="instance-peers" [attr.aria-label]="'environments.pairing.title' | transloco">
      <header>
        <div>
          <h4>{{ 'environments.pairing.title' | transloco }}</h4>
          <p>{{ 'environments.pairing.trust' | transloco }}</p>
        </div>
        @if (!readOnly) {
          <div class="actions">
            <button
              type="button"
              class="btn btn-sm"
              [disabled]="peerBusy()"
              (click)="invite()"
              data-testid="instance-invite"
            >
              {{ 'environments.pairing.invite' | transloco }}
            </button>
          </div>
        }
      </header>
      @if (!readOnly) {
        <div class="row stack">
          <p class="hint">{{ 'environments.pairing.keyPolicy' | transloco }}</p>
          <label class="flex items-center gap-2 t-sm">
            <input
              type="checkbox"
              class="checkbox checkbox-sm"
              [checked]="relay()"
              (change)="relay.set($any($event.target).checked)"
            />
            {{ 'environments.pairing.phones' | transloco }}
          </label>
          @if (invitation()) {
            <label class="flex flex-col gap-1 t-sm">
              {{ 'environments.pairing.copy' | transloco }}
              <textarea
                class="textarea textarea-sm w-full"
                rows="3"
                readonly
                [value]="invitation()"
                data-testid="instance-invitation"
              ></textarea>
            </label>
          }
          <label class="flex flex-col gap-1 t-sm">
            {{ 'environments.pairing.paste' | transloco }}
            <textarea
              class="textarea textarea-sm w-full"
              rows="3"
              autocomplete="off"
              [value]="pasted()"
              (input)="pasted.set($any($event.target).value)"
              data-testid="instance-paste"
            ></textarea>
          </label>
          <div class="ctl ctl-w wrap">
            <button
              type="button"
              class="btn btn-sm"
              [disabled]="peerBusy() || !pasted().trim()"
              (click)="connect()"
              data-testid="instance-connect"
            >
              {{ 'environments.pairing.connect' | transloco }}
            </button>
          </div>
        </div>
      }
      @for (request of peers()?.requests ?? []; track request.pairId) {
        <div class="row" data-testid="instance-request">
          <div class="min-w-0">
            <div class="lbl">
              {{ request.name }}<strong class="mono">{{ request.confirmationCode }}</strong>
            </div>
            <div class="hint">{{ request.origin }} · {{ 'environments.pairing.compare' | transloco }}</div>
            <p class="sub mono break-all">{{ request.fingerprint }}</p>
          </div>
          <div class="ctl ctl-w wrap">
            <button
              type="button"
              class="btn btn-sm btn-primary"
              [disabled]="peerBusy()"
              (click)="approve(request.pairId)"
            >
              {{ 'environments.pairing.approve' | transloco }}
            </button>
            <button type="button" class="btn btn-sm btn-ghost" [disabled]="peerBusy()" (click)="reject(request.pairId)">
              {{ 'environments.pairing.reject' | transloco }}
            </button>
          </div>
        </div>
      }
      @for (peer of peers()?.peers ?? []; track peer.peerId) {
        <div class="row" data-testid="instance-peer">
          <div class="min-w-0">
            <div class="lbl">
              {{ peer.name }}
              <span
                class="chip"
                [class.ok]="peer.state === 'active'"
                [class.warn]="peer.state === 'pending'"
                [class.off]="peer.state === 'revoked'"
              >
                {{ 'environments.pairing.' + peer.state | transloco }}
              </span>
              @if (peer.state === 'pending' && peer.confirmationCode) {
                <strong class="mono">{{ peer.confirmationCode }}</strong>
              }
            </div>
            <div class="hint">{{ peer.origin }}</div>
            <p class="sub mono break-all">{{ peer.peerId }}</p>
            @if (peer.unpairPending) {
              <p class="sub warn">{{ 'environments.pairing.unpairPending' | transloco }}</p>
            }
          </div>
          @if (!readOnly) {
            <div class="ctl ctl-w wrap">
              <button type="button" class="btn btn-sm btn-ghost" [disabled]="peerBusy()" (click)="renamePeer(peer)">
                {{ 'environments.pairing.rename' | transloco }}
              </button>
              @if (peer.state !== 'revoked') {
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  [disabled]="peerBusy()"
                  (click)="unpair(peer.peerId)"
                >
                  {{ 'environments.pairing.unpair' | transloco }}
                </button>
              }
            </div>
          }
        </div>
      }
      @if (peerError()) {
        <p class="row sub err" role="alert">{{ peerError() }}</p>
      }
    </section>
  `,
})
export class EnvironmentPeersSection implements OnInit {
  private readonly api = inject(EntryApiClient);
  private readonly environments = inject(EnvironmentsStore);
  private readonly dialogs = inject(DialogStore);
  private readonly i18n = inject(Language);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly readOnly = isDeviceConnection();
  protected readonly peers = signal<PeerManager | undefined>(undefined);
  protected readonly invitation = signal('');
  protected readonly pasted = signal('');
  protected readonly relay = signal(true);
  protected readonly peerBusy = signal(false);
  protected readonly peerError = signal('');
  private invitationExpiry = 0;

  ngOnInit(): void {
    void this.loadPeers();
    const timer = setInterval(() => {
      if (this.invitationExpiry <= Date.now()) this.invitation.set('');
      if (
        this.invitation() ||
        this.peers()?.requests.length ||
        this.peers()?.peers.some((peer) => peer.state === 'pending' || peer.unpairPending)
      )
        void this.loadPeers();
    }, 2000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.invitation.set('');
      this.pasted.set('');
    });
  }

  private async loadPeers(): Promise<void> {
    try {
      const value = await unwrap(peersList({ client: this.api.client }));
      if (!this.destroyRef.destroyed) this.peers.set(value);
    } catch {
      /* Naming/local use remains available when remote enrollment is unavailable. */
    }
  }
  private async peerAction(work: () => Promise<unknown>): Promise<void> {
    if (this.readOnly || this.peerBusy()) return;
    this.peerBusy.set(true);
    this.peerError.set('');
    try {
      await work();
      await this.loadPeers();
      void this.environments.refresh();
    } catch (error) {
      if (!this.destroyRef.destroyed) this.peerError.set(errorMessage(error));
    } finally {
      if (!this.destroyRef.destroyed) this.peerBusy.set(false);
    }
  }
  protected invite(): Promise<void> {
    return this.peerAction(async () => {
      const value = await unwrap(peersInvite({ client: this.api.client }));
      if (!this.destroyRef.destroyed) {
        this.invitation.set(value.invitation);
        this.invitationExpiry = value.expiresAt;
      }
    });
  }
  protected connect(): Promise<void> {
    const invitation = this.pasted().trim();
    this.pasted.set('');
    return this.peerAction(() =>
      unwrap(peersConnect({ client: this.api.client, body: { invitation, allowRelay: this.relay() } })),
    );
  }
  protected approve(pairId: string): Promise<void> {
    return this.peerAction(() =>
      unwrap(peersApprove({ client: this.api.client, path: { pairId }, body: { allowRelay: this.relay() } })),
    );
  }
  protected reject(pairId: string): Promise<void> {
    return this.peerAction(() => unwrap(peersReject({ client: this.api.client, path: { pairId } })));
  }
  protected async unpair(peerId: string): Promise<void> {
    if (!window.confirm(this.i18n.t('environments.pairing.unpairQuestion'))) return;
    await this.peerAction(() => unwrap(peersUnpair({ client: this.api.client, path: { peerId } })));
  }
  protected async renamePeer(peer: PeerSummary): Promise<void> {
    const name = await this.dialogs.askName(peer.name, this.i18n.t('environments.pairing.rename'));
    if (name)
      await this.peerAction(() =>
        unwrap(peersRename({ client: this.api.client, path: { peerId: peer.peerId }, body: { name } })),
      );
  }
}
