import { PkIcon } from '@pi-kit/design-system';
import { PkSetting } from '@pi-kit/settings/api';
import { readStorage, writeStorage } from '@pi-kit/data-access';
import { DatePipe } from '@angular/common';
import { toDataURL } from 'qrcode';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { RemoteAccessStatus, RemoteAccessSetupAction } from '@pi-kit/protocol';

const PORT_STORAGE_KEY = 'pi-kit.remoteAccess.port';

/** Desktop-owned, explicitly enabled remote access. Pairing secrets stay in memory. */
@Component({
  selector: 'pk-remote-access-section',
  imports: [TranslocoPipe, DatePipe, PkIcon, PkSetting],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-access-section.html',
  styleUrl: './remote-access-section.css',
})
export class RemoteAccessSection implements OnInit {
  private static parsePort(value: string): number | undefined {
    if (!/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return port >= 1 && port <= 65535 ? port : undefined;
  }
  // A web renderer must not synthesize a desktop bridge or use backend APIs as a fallback.
  private readonly bridge = window.piKit;
  protected readonly desktop = typeof this.bridge?.getRemoteAccessStatus === 'function';
  private readonly destroyRef = inject(DestroyRef);
  private generation = 0;
  private pollPending = false;
  private qrUrl?: string;
  protected readonly actionError = signal<string | undefined>(undefined);
  protected readonly pairingRequested = signal(false);
  protected readonly qr = signal<string | undefined>(undefined);
  protected readonly now = signal(Date.now());
  protected readonly activePairing = computed(() => {
    const pairing = this.status()?.pairing;
    return this.pairingRequested() && this.status()?.state === 'serving' && pairing && pairing.expiresAt > this.now()
      ? pairing
      : undefined;
  });
  protected readonly status = signal<RemoteAccessStatus | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly port = signal('8443');
  protected readonly selectedPort = computed(() => RemoteAccessSection.parsePort(this.port()));
  protected readonly portLocked = computed(
    () => this.busy() || ['serving', 'starting'].includes(this.status()?.state ?? ''),
  );
  protected readonly steps = computed(() => {
    const status = this.status();
    const connected = ['available', 'starting', 'serving'].includes(status?.state ?? '');
    const https = status?.httpsReady === true || status?.state === 'serving';
    return [
      {
        done: connected,
        current: false,
        title: connected ? 'connectedTitle' : 'connectTitle',
        help: connected ? 'connectedHelp' : 'explanation',
        actions: 'tailscale',
      },
      {
        done: https,
        current: !https && ['https', 'authorize'].includes(this.setupAction() ?? ''),
        title: https ? 'httpsApprovedTitle' : 'httpsTitle',
        help: https ? 'httpsApprovedHelp' : 'httpsHelp',
        actions: 'https',
      },
      { done: false, current: false, title: 'enableTitle', help: 'enableHelp', actions: '' },
    ];
  });
  protected readonly message = computed(() => this.actionError() || this.status()?.message);
  protected readonly failed = computed(
    () => !!this.actionError() || this.needsSetup() || this.status()?.state === 'error',
  );
  protected readonly stateKey = computed(() => (this.needsSetup() ? 'setup' : (this.status()?.state ?? 'checking')));
  protected readonly canEnable = computed(() => {
    const status = this.status();
    return (
      this.desktop &&
      this.selectedPort() !== undefined &&
      ((status?.state === 'available' && !status.issue) ||
        (status?.state === 'error' && (!status.issue || status.issue === 'start-failed')))
    );
  });
  protected readonly setupOpened = signal(false);
  protected readonly needsSetup = computed(() =>
    ['cli-unavailable', 'connection-required', 'https-required', 'approval-required'].includes(
      this.status()?.issue ?? '',
    ),
  );
  protected readonly setupAction = computed(() => this.status()?.setupAction);
  protected readonly canOpenSetup = typeof this.bridge?.openRemoteAccessSetup === 'function';

  protected openSetup(action: RemoteAccessSetupAction): Promise<void> {
    const open = this.bridge?.openRemoteAccessSetup;
    return open
      ? this.run(
          () => open(action),
          () => this.setupOpened.set(true),
        )
      : Promise.resolve();
  }

  protected readonly servingUrl = computed(() => {
    const status = this.status();
    if (status?.state !== 'serving' || !status.url) return undefined;
    try {
      const url = new URL(status.url);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  });

  ngOnInit(): void {
    const saved = readStorage(PORT_STORAGE_KEY, 'controller');
    if (saved && RemoteAccessSection.parsePort(saved) !== undefined) this.port.set(saved);
    void this.refresh();
    if (!this.desktop) return;
    const timer = setInterval(() => {
      this.now.set(Date.now());
      if (this.status()?.state === 'serving') void this.poll();
    }, 2000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.generation++;
      this.qr.set(undefined);
    });
  }

  protected pair(): Promise<void> {
    if (this.status()?.state !== 'serving') return Promise.resolve();
    this.pairingRequested.set(true);
    return this.call((bridge) => bridge.beginRemotePairing?.());
  }
  protected approve(id: string): Promise<void> {
    return this.call((bridge) => bridge.approveRemotePairing?.(id));
  }
  protected reject(id: string): Promise<void> {
    return this.call((bridge) => bridge.rejectRemotePairing?.(id));
  }
  protected revoke(id: string): Promise<void> {
    return this.call((bridge) => bridge.revokeRemoteDevice?.(id));
  }

  private async poll(): Promise<void> {
    if (this.busy() || this.pollPending || !this.bridge?.getRemoteAccessStatus) return;
    const generation = this.generation;
    this.pollPending = true;
    try {
      const status = await this.bridge.getRemoteAccessStatus();
      if (this.live(generation) && !this.busy()) this.applyStatus(status);
    } catch {
      // Background refresh must not hide an explicit action failure or disrupt pairing.
    } finally {
      this.pollPending = false;
    }
  }

  protected changePort(value: string): void {
    if (this.portLocked()) return;
    this.port.set(value);
    if (RemoteAccessSection.parsePort(value) !== undefined) writeStorage(PORT_STORAGE_KEY, value, 'controller');
  }

  private applyStatus(status: RemoteAccessStatus): void {
    this.status.set(status);
    if (
      (status.state === 'serving' || status.state === 'starting') &&
      RemoteAccessSection.parsePort(String(status.port)) !== undefined
    ) {
      this.port.set(String(status.port));
      writeStorage(PORT_STORAGE_KEY, String(status.port), 'controller');
    }
    if (status.state !== 'serving') this.pairingRequested.set(false);
    const pairing = this.activePairing();
    const url = pairing?.url;
    if (url === this.qrUrl) return;
    this.qrUrl = url;
    this.qr.set(undefined);
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || !parsed.hash) return;
    } catch {
      return;
    }
    void toDataURL(url, { width: 240, margin: 2 })
      .then((image) => {
        if (!this.destroyRef.destroyed && this.qrUrl === url) this.qr.set(image);
      })
      .catch(() => {
        // The human-readable pairing code remains usable when QR generation fails.
      });
  }

  protected refresh(): Promise<void> {
    this.setupOpened.set(false);
    return this.call((bridge) => bridge.getRemoteAccessStatus?.());
  }
  protected start(): Promise<void> {
    const port = this.selectedPort();
    if (!this.canEnable() || port === undefined) return Promise.resolve();
    return this.call((bridge) => bridge.startRemoteAccess?.(port));
  }
  protected stop(): Promise<void> {
    return this.call((bridge) => bridge.stopRemoteAccess?.());
  }
  private call(
    action: (bridge: NonNullable<typeof window.piKit>) => Promise<RemoteAccessStatus> | undefined,
  ): Promise<void> {
    const result = this.bridge && action(this.bridge);
    return result
      ? this.run(
          () => result,
          (status) => this.applyStatus(status),
        )
      : Promise.resolve();
  }

  private live(generation: number): boolean {
    return !this.destroyRef.destroyed && generation === this.generation;
  }

  private async run<T>(action: () => Promise<T>, done: (value: T) => void): Promise<void> {
    if (!this.desktop || this.busy()) return;
    this.busy.set(true);
    const generation = ++this.generation;
    this.actionError.set(undefined);
    try {
      const value = await action();
      if (this.live(generation)) done(value);
    } catch (error) {
      if (this.live(generation)) this.actionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.live(generation)) this.busy.set(false);
    }
  }
}
