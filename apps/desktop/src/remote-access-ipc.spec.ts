import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { RemoteAccessIpc } from './remote-access-ipc';
import type { RemoteAccessSetupAction } from '@pi-kit/protocol';

function setup(allowed = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, id?: unknown) => unknown>();
  const ipc = {
    handle: vi.fn((channel, listener) => handlers.set(channel, listener)),
  } as Pick<IpcMain, 'handle'>;
  const controller = {
    beginPairing: vi.fn(async () => ({ state: 'serving' as const })),
    approvePairing: vi.fn(async (_id: string) => ({ state: 'serving' as const })),
    rejectPairing: vi.fn(async (_id: string) => ({ state: 'serving' as const })),
    revokeDevice: vi.fn(async (_id: string) => ({ state: 'serving' as const })),
    status: vi.fn(async () => ({ state: 'available' as const })),
    start: vi.fn(async () => ({ state: 'serving' as const })),
    stop: vi.fn(async () => ({ state: 'available' as const })),
  };
  const fromRenderer = vi.fn(() => allowed);
  const shuttingDown = vi.fn(() => false);
  const openSetup = vi.fn(async (_action: RemoteAccessSetupAction) => undefined);
  new RemoteAccessIpc(controller, fromRenderer, shuttingDown, openSetup).register(ipc);
  const event = { senderFrame: { url: 'https://untrusted.example' } } as IpcMainInvokeEvent;
  return { controller, handlers, fromRenderer, shuttingDown, openSetup, event };
}

describe('remote access IPC', () => {
  it('registers management without running discovery or publishing anything', () => {
    const { controller, handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      'pi-kit:remote-access-setup',
      'pi-kit:remote-access-status',
      'pi-kit:remote-access-start',
      'pi-kit:remote-access-stop',
      'pi-kit:remote-pair-begin',
      'pi-kit:remote-pair-approve',
      'pi-kit:remote-pair-reject',
      'pi-kit:remote-device-revoke',
    ]);
    for (const method of Object.values(controller)) expect(method).not.toHaveBeenCalled();
  });

  it.each(['status', 'start', 'stop'] as const)(
    'denies untrusted %s calls before accessing the controller',
    (action) => {
      const { controller, handlers, fromRenderer, event } = setup(false);
      expect(() => handlers.get(`pi-kit:remote-access-${action}`)?.(event)).toThrow('forbidden');
      expect(fromRenderer).toHaveBeenCalledWith(event);
      for (const method of Object.values(controller)) expect(method).not.toHaveBeenCalled();
    },
  );

  it.each(['status', 'start', 'stop'] as const)('forwards trusted %s calls', async (action) => {
    const { controller, handlers, event } = setup();
    await handlers.get(`pi-kit:remote-access-${action}`)?.(event);
    expect(controller[action]).toHaveBeenCalledOnce();
  });

  it('opens setup only after a trusted explicit enum action, never accepts a URL', async () => {
    const { handlers, event, openSetup, fromRenderer, shuttingDown } = setup();
    expect(openSetup).not.toHaveBeenCalled();
    for (const action of ['tailscale', 'https', 'authorize']) {
      await handlers.get('pi-kit:remote-access-setup')?.(event, action);
      expect(openSetup).toHaveBeenLastCalledWith(action);
    }
    for (const action of [undefined, {}, 'https://evil.example', '--connect', '']) {
      expect(() => handlers.get('pi-kit:remote-access-setup')?.(event, action)).toThrow('Invalid');
    }
    fromRenderer.mockReturnValue(false);
    expect(() => handlers.get('pi-kit:remote-access-setup')?.(event, 'https')).toThrow('forbidden');
    fromRenderer.mockReturnValue(true);
    shuttingDown.mockReturnValue(true);
    expect(() => handlers.get('pi-kit:remote-access-setup')?.(event, 'tailscale')).toThrow('forbidden');
    expect(openSetup).toHaveBeenCalledTimes(3);
  });

  it('does not permit starting new publication during quit, or mutations', async () => {
    const { controller, handlers, shuttingDown, event } = setup();
    shuttingDown.mockReturnValue(true);
    expect(() => handlers.get('pi-kit:remote-access-start')?.(event)).toThrow('forbidden');
    expect(controller.start).not.toHaveBeenCalled();
    expect(() => handlers.get('pi-kit:remote-access-stop')?.(event)).toThrow('forbidden');
    expect(controller.stop).not.toHaveBeenCalled();
  });
});

it.each(['pi-kit:remote-pair-approve', 'pi-kit:remote-pair-reject', 'pi-kit:remote-device-revoke'])(
  'validates and authorizes %s',
  async (channel) => {
    const { handlers, event, controller, shuttingDown, fromRenderer } = setup();
    for (const id of [undefined, null, 1, '', 'x'.repeat(129), '--path /tmp'])
      expect(() => handlers.get(channel)?.(event, id)).toThrow('Invalid');
    await handlers.get(channel)?.(event, 'opaque-id_123');
    expect(
      [controller.approvePairing, controller.rejectPairing, controller.revokeDevice].some(
        (fn) => fn.mock.calls.length === 1,
      ),
    ).toBe(true);
    shuttingDown.mockReturnValue(true);
    expect(() => handlers.get(channel)?.(event, 'opaque')).toThrow('forbidden');
    shuttingDown.mockReturnValue(false);
    fromRenderer.mockReturnValue(false);
    expect(() => handlers.get(channel)?.(event, 'opaque')).toThrow('forbidden');
  },
);

it('validates the optional numeric external port before forwarding trusted starts', async () => {
  const { handlers, event, controller } = setup();
  const start = handlers.get('pi-kit:remote-access-start')!;
  for (const port of [0, 65536, -1, 1.5, '9443', NaN, null, Infinity])
    expect(() => start(event, port)).toThrow('Invalid');
  expect(controller.start).not.toHaveBeenCalled();
  for (const port of [undefined, 9443, 443, 1, 65535]) {
    await start(event, port);
    expect(controller.start).toHaveBeenLastCalledWith(port);
  }
});
