import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINUX_BWRAP, LINUX_SETUP_SCRIPT, setUpLinuxSandbox } from './linux-sandbox-setup';

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
afterEach(() => Object.defineProperty(process, 'platform', platform));

describe('Linux sandbox setup', () => {
  it('installs pi-kit’s bwrap and its AppArmor profile through pkexec, and reports a dismissed password dialog', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const run = vi.fn(async () => ({ code: 0, stderr: '' }));
    await setUpLinuxSandbox(run, process.execPath);
    expect(run).toHaveBeenCalledWith('pkexec', ['/bin/sh', '-c', LINUX_SETUP_SCRIPT, 'pi-kit-setup', process.execPath]);
    expect(LINUX_SETUP_SCRIPT).toContain(`profile pi-kit-bwrap ${LINUX_BWRAP} flags=(unconfined)`);
    run.mockResolvedValueOnce({ code: 126, stderr: '' });
    await expect(setUpLinuxSandbox(run, process.execPath)).rejects.toThrow('cancelled');
    run.mockResolvedValueOnce({ code: 1, stderr: 'apparmor_parser: not found' });
    await expect(setUpLinuxSandbox(run, process.execPath)).rejects.toThrow('apparmor_parser: not found');
  });
});
