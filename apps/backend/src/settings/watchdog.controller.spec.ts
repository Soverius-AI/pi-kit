import { describe, expect, it, vi } from 'vitest';
import { SettingsController } from './settings.controller';

describe('owner watchdog settings', () => {
  function controller(watchdog = vi.fn()) {
    // Only these endpoints use the bridge; the pi dependencies remain untouched.
    const instance = Object.create(SettingsController.prototype) as SettingsController;
    Object.assign(instance, { desktop: { watchdog } });
    return { instance, watchdog };
  }
  it('gets current host support and forwards both toggle values', async () => {
    const { instance, watchdog } = controller();
    watchdog.mockResolvedValue({ enabled: false, supported: true });
    expect(await instance.watchdog()).toEqual({ enabled: false, supported: true });
    await instance.setWatchdog({ enabled: true });
    await instance.setWatchdog({ enabled: false });
    expect(watchdog.mock.calls).toEqual([[], [true], [false]]);
  });
  it('returns unsupported state and maps a failed setting to a bad request', async () => {
    const { instance, watchdog } = controller();
    watchdog.mockResolvedValueOnce({ enabled: false, supported: false });
    expect(await instance.watchdog()).toEqual({ enabled: false, supported: false });
    watchdog.mockRejectedValueOnce(new Error('host unavailable'));
    await expect(instance.setWatchdog({ enabled: true })).rejects.toMatchObject({
      status: 400,
      message: 'host unavailable',
    });
  });
});
