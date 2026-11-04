import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RemoteAccessSetupAction } from '@pi-kit/protocol';
import type { RemoteAccess } from './remote-access';

type RemoteAccessController = Pick<
  RemoteAccess,
  'status' | 'start' | 'stop' | 'beginPairing' | 'approvePairing' | 'rejectPairing' | 'revokeDevice'
>;

/** Only the trusted desktop renderer may discover or manage the authenticated phone gateway. */
export class RemoteAccessIpc {
  constructor(
    private readonly controller: RemoteAccessController,
    private readonly fromRenderer: (event: IpcMainInvokeEvent) => boolean,
    private readonly shuttingDown: () => boolean,
    private readonly openSetup?: (action: RemoteAccessSetupAction) => Promise<void>,
  ) {}

  register(ipc: Pick<IpcMain, 'handle'>): void {
    ipc.handle('pi-kit:remote-access-setup', (event, action: unknown) => {
      if (!this.fromRenderer(event) || this.shuttingDown()) throw new Error('forbidden');
      if (action !== 'tailscale' && action !== 'https' && action !== 'authorize')
        throw new Error('Invalid phone setup action');
      if (!this.openSetup) throw new Error('Phone setup actions are unavailable');
      return this.openSetup(action);
    });
    for (const [channel, action] of [
      ['pi-kit:remote-access-status', 'status'],
      ['pi-kit:remote-access-start', 'start'],
      ['pi-kit:remote-access-stop', 'stop'],
      ['pi-kit:remote-pair-begin', 'beginPairing'],
    ] as const) {
      ipc.handle(channel, (event, port: unknown) => {
        if (!this.fromRenderer(event) || (action !== 'status' && this.shuttingDown())) throw new Error('forbidden');
        if (action === 'start') {
          if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535))
            throw new Error('Invalid remote access port');
          return this.controller.start(port as number | undefined);
        }
        return this.controller[action]();
      });
    }
    for (const [channel, action] of [
      ['pi-kit:remote-pair-approve', 'approvePairing'],
      ['pi-kit:remote-pair-reject', 'rejectPairing'],
      ['pi-kit:remote-device-revoke', 'revokeDevice'],
    ] as const) {
      ipc.handle(channel, (event, id: unknown) => {
        if (!this.fromRenderer(event) || this.shuttingDown()) throw new Error('forbidden');
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid remote access ID');
        return this.controller[action](id);
      });
    }
  }
}
