import type { Shell } from 'electron';
import { join } from 'node:path';
import type { RemoteAccessSetupAction } from '@pi-kit/protocol';
import { tailscaleApprovalUrl } from '@pi-kit/service-host';

/** Explicit user actions only. Does not run up/down, install certificates, or edit tailnet policy. */
export class RemoteAccessSetup {
  static readonly HTTPS_SETTINGS = 'https://login.tailscale.com/admin/dns';

  constructor(
    private readonly shell: Pick<Shell, 'openPath' | 'openExternal'>,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async open(action: RemoteAccessSetupAction, approvalUrl?: string): Promise<void> {
    if (action === 'https') return this.page(RemoteAccessSetup.HTTPS_SETTINGS);
    if (action === 'authorize') {
      const url = tailscaleApprovalUrl(approvalUrl);
      if (!url) throw new Error('No HTTPS approval link is available. Open Tailscale HTTPS settings and check again.');
      return this.page(url);
    }
    if (action !== 'tailscale') throw new Error('Invalid phone setup action.');
    if (this.platform !== 'darwin' && this.platform !== 'win32')
      return this.page('https://tailscale.com/kb/1017/install');
    const path =
      this.platform === 'darwin'
        ? '/Applications/Tailscale.app'
        : join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tailscale', 'tailscale-ipn.exe');
    if (await this.shell.openPath(path))
      throw new Error(
        'Tailscale could not be opened. Install or open Tailscale, connect to your tailnet, then check again.',
      );
  }

  private async page(url: string): Promise<void> {
    try {
      await this.shell.openExternal(url);
    } catch {
      throw new Error('Could not open your browser. Open the Tailscale admin console manually, then check again.');
    }
  }
}
