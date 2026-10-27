import { Global, Module } from '@nestjs/common';
import { DesktopBridge } from './desktop-bridge';

/** The `DesktopBridge` to the Electron host, global so any module can inject it without importing this one. */
@Global()
@Module({ providers: [DesktopBridge], exports: [DesktopBridge] })
export class DesktopModule {}
