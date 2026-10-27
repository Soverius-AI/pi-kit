import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ScreenshotFormatSchema, ScreenshotQualitySchema, DEFAULT_SCREENSHOT_FORMAT, DEFAULT_SCREENSHOT_QUALITY, type BrowserAction, type BrowserResult, type BrowserState } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
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
  constructor(private readonly desktop: DesktopBridge, private readonly threads: ThreadsRepository, private readonly sessions: PiSessionService, private readonly meta: MetaRepository) {}

  get available(): boolean { return this.desktop.available; }

  onModuleInit(): void { this.sessions.setBrowser(this); }
  onModuleDestroy(): void { this.sessions.setBrowser(undefined); }

  async state(threadId: string): Promise<BrowserState> {
    this.requireThread(threadId);
    return (await this.desktop.browser(threadId)).state;
  }

  async run(threadId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserResult> {
    this.requireThread(threadId);
    if (!this.available) throw new ServiceUnavailableException('Browser artifacts are available in the pi-kit desktop app.');
    if (action.action === 'screenshot') {
      action = {
        ...action,
        format: action.format ?? (ScreenshotFormatSchema.safeParse(this.meta.getSetting('screenshotFormat')).data ?? DEFAULT_SCREENSHOT_FORMAT),
        quality: action.quality ?? (ScreenshotQualitySchema.safeParse(this.meta.getSetting('screenshotQuality')).data ?? DEFAULT_SCREENSHOT_QUALITY),
      };
    }
    return this.desktop.browser(threadId, action, signal);
  }

  private requireThread(id: string): void {
    if (!this.threads.get(id)) throw new NotFoundException('There is no such thread.');
  }
}
