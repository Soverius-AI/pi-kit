import {
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ScreenshotFormatSchema,
  ScreenshotQualitySchema,
  DEFAULT_SCREENSHOT_FORMAT,
  DEFAULT_SCREENSHOT_QUALITY,
  LoopbackUrl,
  type BrowserAction,
  type BrowserResult,
  type BrowserState,
} from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { PeersRepository, type PeerRecord } from '../db/peers.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { PiSessionService } from '../pi/pi-session.service';

/**
 * The browser artifact of a thread, forwarded to the desktop app over the `DesktopBridge`, so it answers only when
 * the desktop hosts the backend. A screenshot takes its format and quality from the settings when the action does
 * not say. The service registers itself with `PiSessionService` while the module lives, so pi's browser tools drive
 * the same page the user sees.
 */
@Injectable()
export class BrowserService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly desktop: DesktopBridge,
    private readonly threads: ThreadsRepository,
    private readonly peers: PeersRepository,
    private readonly sessions: PiSessionService,
    private readonly meta: MetaRepository,
  ) {}

  get available(): boolean {
    return this.desktop.available;
  }

  onModuleInit(): void {
    this.sessions.setBrowser(this);
  }
  onModuleDestroy(): void {
    this.sessions.setBrowser(undefined);
  }

  async state(threadId: string): Promise<BrowserState> {
    this.requireThread(threadId);
    return (await this.desktop.browser(threadId)).state;
  }

  async run(threadId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    this.requireThread(threadId);
    return this.drive(threadId, action, signal);
  }

  /** The page this desktop shows for a thread of a paired instance. The thread lives there; the page lives here. */
  async peerState(peerId: string, threadId: string): Promise<BrowserState> {
    this.requirePeer(peerId);
    return (await this.desktop.browser(threadId)).state;
  }

  /** Drives that page. A loopback address means the paired computer, so it is opened at that computer's tailnet name. */
  async peerRun(peerId: string, threadId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    const host = new URL(this.requirePeer(peerId).identity.origin).hostname;
    const url = action.action === 'navigate' && action.url ? LoopbackUrl.toHost(action.url, host) : undefined;
    return this.drive(threadId, url ? { ...action, url } : action, signal);
  }

  private async drive(threadId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    if (!this.available)
      throw new ServiceUnavailableException('Browser artifacts are available in the pi-kit desktop app.');
    if (action.action === 'screenshot') {
      action = {
        ...action,
        format:
          action.format ??
          ScreenshotFormatSchema.safeParse(this.meta.getSetting('screenshotFormat')).data ??
          DEFAULT_SCREENSHOT_FORMAT,
        quality:
          action.quality ??
          ScreenshotQualitySchema.safeParse(this.meta.getSetting('screenshotQuality')).data ??
          DEFAULT_SCREENSHOT_QUALITY,
      };
    }
    return this.desktop.browser(threadId, action, signal);
  }

  private requireThread(id: string): void {
    if (!this.threads.get(id)) throw new NotFoundException('There is no such thread.');
  }

  private requirePeer(id: string): PeerRecord {
    const peer = this.peers.get(id);
    if (peer?.state !== 'active') throw new NotFoundException('There is no such paired instance.');
    return peer;
  }
}
