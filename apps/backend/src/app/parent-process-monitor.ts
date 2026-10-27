import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DEFAULT_SHUTDOWN_POLICY, type BackendConfig } from './config';
import { CONFIG } from './config.token';

/** Parent loss enters Nest's normal SIGTERM path; a stalled shutdown still has a deadline. */
@Injectable()
export class ParentProcessMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private readonly boundShutdown = (): void => {
    if (this.deadline) return;
    this.deadline = setTimeout(() => {
      Logger.error('Backend shutdown exceeded its grace period.');
      process.exit(1);
    }, this.config.shutdown?.graceMs ?? DEFAULT_SHUTDOWN_POLICY.graceMs);
    // Nest terminates the process when hooks complete; this deadline must not keep it alive.
    this.deadline.unref();
  };

  constructor(@Inject(CONFIG) private readonly config: BackendConfig) {}

  onApplicationBootstrap(): void {
    process.prependListener('SIGINT', this.boundShutdown);
    process.prependListener('SIGTERM', this.boundShutdown);
    const parent = this.config.shutdown?.parentPid;
    if (!parent || parent === process.pid) return;
    this.timer = setInterval(() => {
      if (this.stopping) return;
      try { process.kill(parent, 0); }
      catch (error) {
        // EPERM means the process exists but cannot be signalled, not that it died.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        this.stopping = true;
        clearInterval(this.timer);
        Logger.warn('The desktop app is gone; requesting Nest shutdown.');
        process.kill(process.pid, 'SIGTERM');
      }
    }, this.config.shutdown?.parentPollMs ?? DEFAULT_SHUTDOWN_POLICY.parentPollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    clearInterval(this.timer);
    process.off('SIGINT', this.boundShutdown);
    process.off('SIGTERM', this.boundShutdown);
    // An already armed, unref'ed deadline remains until Nest finishes every shutdown
    // hook and exits. Clearing it here would leave later hooks free to hang forever.
  }
}
