import { describe, expect, it, vi } from 'vitest';
import { tailscaleApprovalUrl } from '@pi-kit/service-host';
import { RemoteAccessSetup } from './remote-access-setup';

const shell = () => ({ openPath: vi.fn(async () => ''), openExternal: vi.fn(async () => undefined) });

describe('remote access setup actions', () => {
  it('opens the existing Mac application without executing VPN or setup commands', async () => {
    const native = shell();
    await new RemoteAccessSetup(native, 'darwin').open('tailscale');
    expect(native.openPath).toHaveBeenCalledExactlyOnceWith('/Applications/Tailscale.app');
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it('opens HTTPS settings without granting consent or changing the tailnet', async () => {
    const native = shell();
    await new RemoteAccessSetup(native, 'darwin').open('https');
    expect(native.openExternal).toHaveBeenCalledExactlyOnceWith(RemoteAccessSetup.HTTPS_SETTINGS);
    expect(native.openPath).not.toHaveBeenCalled();
  });

  it('opens only a validated Tailscale approval page supplied by the controller', async () => {
    const native = shell();
    const url = 'https://login.tailscale.com/f/serve?node=test-only';
    await new RemoteAccessSetup(native, 'darwin').open('authorize', url);
    expect(native.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    await expect(new RemoteAccessSetup(native, 'darwin').open('authorize', 'https://evil.example')).rejects.toThrow(
      'No HTTPS approval link',
    );
    expect(native.openExternal).toHaveBeenCalledOnce();
  });

  it('gives guidance rather than leaking native OS error text', async () => {
    const native = shell();
    native.openPath.mockResolvedValue('private path or diagnostic');
    await expect(new RemoteAccessSetup(native, 'darwin').open('tailscale')).rejects.toThrow(
      'Install or open Tailscale',
    );
  });

  it.each([
    undefined,
    'javascript:alert(1)',
    'http://login.tailscale.com/f/serve',
    'https://login.tailscale.com.evil/f/serve',
    'https://user:secret@login.tailscale.com/f/serve',
    'https://login.tailscale.com/unknown',
    'https://login.tailscale.com/f/serve#fragment',
    'https://login.tailscale.com/f/serve' + 'a'.repeat(2050),
  ])('rejects untrusted approval input %s', (value) => {
    expect(tailscaleApprovalUrl(value)).toBeUndefined();
  });
});
