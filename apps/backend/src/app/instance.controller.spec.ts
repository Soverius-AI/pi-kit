import { describe, expect, it, vi } from 'vitest';
import { InstanceController } from './instance.controller';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('instance persistence acknowledgments', () => {
  it.each(['endpoint', 'saveDevice', 'revokeDevice'] as const)('%s waits for durable commit', async (operation) => {
    const commit = deferred();
    const write = vi.fn(() => commit.promise);
    const controller = new InstanceController(
      { saveDevice: write, revokeDevice: write } as never,
      { setOrigin: write } as never,
    );
    const response =
      operation === 'endpoint'
        ? controller.endpoint({ origin: 'https://owner.example' })
        : operation === 'saveDevice'
          ? controller.saveDevice({ id: 'device' } as never)
          : controller.revokeDevice('device');
    let acknowledged = false;
    void response.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    expect(acknowledged).toBe(false);
    commit.resolve();
    await expect(response).resolves.toEqual(operation === 'revokeDevice' ? { revoked: true } : { saved: true });
  });

  it.each(['endpoint', 'saveDevice', 'revokeDevice'] as const)(
    '%s rejects instead of acknowledging a failed commit',
    async (operation) => {
      const write = vi.fn(async () => {
        throw new Error('durable commit failed');
      });
      const controller = new InstanceController(
        { saveDevice: write, revokeDevice: write } as never,
        { setOrigin: write } as never,
      );
      const response =
        operation === 'endpoint'
          ? controller.endpoint({ origin: 'https://owner.example' })
          : operation === 'saveDevice'
            ? controller.saveDevice({ id: 'device' } as never)
            : controller.revokeDevice('device');
      await expect(response).rejects.toThrow('durable commit failed');
    },
  );
});
