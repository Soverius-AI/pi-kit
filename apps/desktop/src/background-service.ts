import type { App } from 'electron';
import { type ServiceManager, serviceManager, serviceName, SUPERVISOR_FLAG } from '@pi-kit/service-host';

export interface BackgroundServiceOptions {
  app: Pick<App, 'isPackaged' | 'getAppPath'>;
  dataDir: string;
  logDir: string;
  hostEntry: string;
  path?: string;
  /** What a development build's host must be told; a packaged host finds it beside itself. */
  devEnv: Record<string, string>;
  stopHost: () => Promise<void>;
}

/**
 * This platform's service manager for this app, registered exactly as `pi-kit service install` registers it. Development and
 * smoke profiles register under a name of their own and tell their host where the development build is.
 */
export function backgroundService(options: BackgroundServiceOptions): ServiceManager | undefined {
  const packaged = options.app.isPackaged;
  return serviceManager({
    name: serviceName(options.dataDir, packaged && !process.env['PI_KIT_SMOKE']),
    program: process.execPath,
    hostEntry: options.hostEntry,
    dataDir: options.dataDir,
    logDir: options.logDir,
    ...(options.path ? { path: options.path } : {}),
    ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
    ...(packaged ? {} : { devEnv: options.devEnv }),
    supervisorArgs: packaged ? [SUPERVISOR_FLAG] : [options.app.getAppPath(), SUPERVISOR_FLAG],
    stopHost: options.stopHost,
  });
}
