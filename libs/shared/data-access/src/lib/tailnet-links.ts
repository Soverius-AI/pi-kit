import { DOCUMENT, DestroyRef, Injectable, inject } from '@angular/core';
import { isDeviceConnection } from '@pi-kit/api';
import { LoopbackUrl } from '@pi-kit/protocol';
import { EnvironmentsStore } from './environments.store';

/**
 * A loopback link (a dev server on `localhost:5173`) means the computer that runs the environment. Away from that computer, on a paired
 * phone or in another computer's environment, the link is pointed at that computer's tailnet name before it opens; the port stays.
 * The server must listen on an address the tailnet reaches, not only on loopback.
 */
@Injectable({ providedIn: 'root' })
export class TailnetLinks {
  private static readonly EVENTS = ['pointerdown', 'click', 'auxclick', 'contextmenu', 'keydown'] as const;
  private readonly document = inject(DOCUMENT);
  private readonly environments = inject(EnvironmentsStore);
  private readonly destroyRef = inject(DestroyRef);
  private installed = false;

  install(): void {
    if (this.installed) return;
    this.installed = true;
    for (const type of TailnetLinks.EVENTS) this.document.addEventListener(type, this.point, true);
    this.destroyRef.onDestroy(() => {
      for (const type of TailnetLinks.EVENTS) this.document.removeEventListener(type, this.point, true);
    });
  }

  /** The computer's tailnet name when loopback links must point there, otherwise undefined. */
  host(): string | undefined {
    if (this.environments.context.remote) {
      const id = this.environments.ownerId();
      const origin = this.environments.manager()?.peers.find((peer) => peer.peerId === id)?.origin;
      return origin ? new URL(origin).hostname : undefined;
    }
    return isDeviceConnection() ? this.document.location.hostname : undefined;
  }

  private readonly point = (event: Event): void => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const host = this.host();
    const target = host && LoopbackUrl.toHost(anchor.href, host);
    if (target) anchor.href = target;
  };
}
