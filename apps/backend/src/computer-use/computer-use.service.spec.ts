import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PiSessionService } from '../pi/pi-session.service';
import type { ComputerUseHostModule, ComputerUsePackage } from './computer-use-package';
import { ComputerUseService } from './computer-use.service';

const PERMISSIONS = [
  { key: 'accessibility', name: 'Accessibility', pane: 'pane:accessibility' },
  { key: 'screenRecording', name: 'Screen & System Audio Recording', pane: 'pane:screen' },
] as const;

function setup(options: { installed?: boolean; enabled?: boolean; granted?: { accessibility: boolean; screenRecording: boolean }; host?: ReturnType<ComputerUseHostModule['host']> } = {}) {
  let enabled = options.enabled ?? false;
  const granted = { ...(options.granted ?? { accessibility: false, screenRecording: false }) };
  const mod: ComputerUseHostModule = {
    isEnabled: () => enabled,
    setEnabled: (on) => void (enabled = on),
    host: () => options.host ?? { name: 'pi-kit', kind: 'app', bundle: '/Applications/pi-kit.app' },
    PERMISSIONS,
    permissions: vi.fn(async () => ({ ...granted })),
    requestPermissions: vi.fn(async () => ({ ...granted })),
  };
  const pkg = { hostModule: async () => (options.installed === false ? undefined : mod) } as unknown as ComputerUsePackage;
  const sessions = { reloadIdleSessions: vi.fn(async () => 2) } as unknown as PiSessionService;
  const service = new ComputerUseService(pkg, sessions);
  service.platform = 'darwin';
  service.openUrl = vi.fn(async () => undefined);
  service.codesignInfo = vi.fn(async () => 'Executable=/Applications/pi-kit.app/Contents/MacOS/pi-kit\nSignature=adhoc\n');
  return { service, mod, sessions, granted };
}

describe('Settings › Computer use', () => {
  it('says when pi has no package, and refuses to switch it on', async () => {
    const { service } = setup({ installed: false });
    expect(await service.state()).toMatchObject({ installed: false, enabled: false, permissions: null });
    await expect(service.setEnabled(true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not load the native library while computer use is off', async () => {
    const { service, mod } = setup();
    expect((await service.state()).permissions).toBeNull();
    expect(mod.permissions).not.toHaveBeenCalled();
  });

  it('switches on, reloads the idle sessions, and then reads what macOS granted', async () => {
    const { service, sessions } = setup({ granted: { accessibility: true, screenRecording: false } });
    const state = await service.setEnabled(true);
    expect(sessions.reloadIdleSessions).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ enabled: true, permissions: { accessibility: true, screenRecording: false }, needsRelaunch: false });
  });

  it('names the app and notices an ad-hoc signature', async () => {
    const { service } = setup({ enabled: true });
    expect((await service.state()).host).toEqual({ name: 'pi-kit', kind: 'app', adHoc: true });
    const dev = setup({ enabled: true, host: { name: 'Electron', kind: 'development', bundle: '/x/Electron.app' } });
    expect((await dev.service.state()).host).toEqual({ name: 'Electron', kind: 'development' });
  });

  it('asks macOS, opens the page, and asks for a relaunch after Screen Recording', async () => {
    const { service, mod } = setup({ enabled: true });
    const accessibility = await service.open('accessibility');
    expect(mod.requestPermissions).toHaveBeenCalled();
    expect(service.openUrl).toHaveBeenCalledWith('pane:accessibility');
    expect(accessibility.needsRelaunch).toBe(false);
    expect((await service.open('screenRecording')).needsRelaunch).toBe(true);
    expect(service.openUrl).toHaveBeenCalledWith('pane:screen');
  });

  it('asks for a relaunch when Screen Recording turns granted while the app runs', async () => {
    const { service, granted } = setup({ enabled: true });
    expect((await service.state()).needsRelaunch).toBe(false);
    granted.screenRecording = true;
    expect((await service.state()).needsRelaunch).toBe(true);
  });

  it.each(['win32', 'linux'] as const)('has nothing to grant on %s', async (platform) => {
    const { service, mod } = setup({ enabled: true });
    service.platform = platform;
    expect(await service.state()).toMatchObject({ supported: true, permissions: null, needsRelaunch: false });
    await service.open('accessibility');
    expect(mod.requestPermissions).not.toHaveBeenCalled();
  });

  it('says whether Linux is Hyprland, and only there', async () => {
    const { service } = setup({ enabled: true });
    service.platform = 'linux';
    service.env = { HYPRLAND_INSTANCE_SIGNATURE: 'abc' };
    expect((await service.state()).hyprland).toBe(true);
    service.env = {};
    expect((await service.state()).hyprland).toBe(false);
    service.platform = 'darwin';
    service.env = { HYPRLAND_INSTANCE_SIGNATURE: 'abc' };
    expect((await service.state()).hyprland).toBeUndefined();
  });

  it('refuses to turn on where Cua Driver does not run', async () => {
    const { service, mod } = setup({ enabled: false });
    service.platform = 'freebsd';
    expect(await service.state()).toMatchObject({ supported: false });
    await expect(service.setEnabled(true)).rejects.toThrow(/macOS, Windows and Linux/);
    expect(mod.isEnabled()).toBe(false);
  });
});
