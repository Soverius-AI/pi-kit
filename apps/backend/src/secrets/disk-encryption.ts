import { execFile } from 'node:child_process';
import type { DiskEncryption } from '@pi-kit/protocol';

/**
 * Whether the disk the data lives on is encrypted (FileVault, BitLocker, LUKS), for Settings › Advanced. OAuth tokens stay in files that pi writes (`auth.json`,
 * `mcp-auth.json`), and full-disk encryption is the protection those files get; the page says whether it is on. Each check is one unprivileged command with a timeout; when it cannot
 * run, the answer is "unknown", never "off".
 */
export type Run = (command: string, args: string[]) => Promise<string>;

export const run: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });

/** `fdesetup status`: "FileVault is On." or "FileVault is Off." (with a note while it is being turned on or off). */
export function parseFdesetup(output: string): DiskEncryption {
  if (/FileVault is On/i.test(output)) return { state: 'on', mechanism: 'FileVault', detail: 'FileVault is on for this Mac’s disk.' };
  if (/FileVault is Off/i.test(output)) return { state: 'off', mechanism: 'FileVault', detail: 'FileVault is off. Turn it on in System Settings › Privacy & Security.' };
  return { state: 'unknown', mechanism: 'FileVault', detail: 'fdesetup did not say.' };
}

interface LsblkNode {
  name?: string;
  type?: string;
  mountpoints?: (string | null)[];
  mountpoint?: string | null;
  children?: LsblkNode[];
}

/** `lsblk -J -o NAME,TYPE,MOUNTPOINTS`: a `crypt` device that carries `/` or `/home` means LUKS. */
export function parseLsblk(output: string, home = '/home'): DiskEncryption {
  let tree: { blockdevices?: LsblkNode[] };
  try {
    tree = JSON.parse(output) as typeof tree;
  } catch {
    return { state: 'unknown', mechanism: 'LUKS', detail: 'lsblk gave no usable answer.' };
  }
  let encryptedRoot = false;
  let anyRoot = false;
  const walk = (nodes: LsblkNode[], underCrypt: boolean): void => {
    for (const node of nodes) {
      const mounts = [...(node.mountpoints ?? []), node.mountpoint].filter((m): m is string => typeof m === 'string');
      const crypt = underCrypt || node.type === 'crypt';
      if (mounts.some((m) => m === '/' || m === home)) {
        anyRoot = true;
        if (crypt) encryptedRoot = true;
      }
      walk(node.children ?? [], crypt);
    }
  };
  walk(tree.blockdevices ?? [], false);
  if (encryptedRoot) return { state: 'on', mechanism: 'LUKS', detail: 'The disk holding / is a LUKS volume.' };
  if (anyRoot) return { state: 'off', mechanism: 'LUKS', detail: 'No LUKS volume holds / or the home folder. Encrypt the disk (or the home folder) to protect pi’s credential files.' };
  return { state: 'unknown', mechanism: 'LUKS', detail: 'lsblk shows no mounted root device (a container or a virtual machine).' };
}

/** The shell property `System.Volume.BitLockerProtection`: 1 is on, 0 is off, 2 is suspended. */
export function parseBitlocker(output: string): DiskEncryption {
  const value = output.trim();
  if (value === '1') return { state: 'on', mechanism: 'BitLocker', detail: 'BitLocker protects the system drive.' };
  if (value === '2') return { state: 'off', mechanism: 'BitLocker', detail: 'BitLocker is suspended on the system drive.' };
  if (value === '0') return { state: 'off', mechanism: 'BitLocker', detail: 'BitLocker is off. Turn it on in Settings › Privacy & security › Device encryption.' };
  return { state: 'unknown', mechanism: 'BitLocker', detail: 'Windows did not say.' };
}

export async function detectDiskEncryption(platform: NodeJS.Platform = process.platform, exec: Run = run, home = '/home'): Promise<DiskEncryption> {
  try {
    if (platform === 'darwin') return parseFdesetup(await exec('/usr/bin/fdesetup', ['status']));
    if (platform === 'win32') {
      const drive = process.env['SystemDrive'] ?? 'C:';
      return parseBitlocker(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Shell.Application).NameSpace('${drive}').Self.ExtendedProperty('System.Volume.BitLockerProtection')`]));
    }
    return parseLsblk(await exec('lsblk', ['-J', '-o', 'NAME,TYPE,MOUNTPOINTS']), home);
  } catch (error) {
    const mechanism = platform === 'darwin' ? 'FileVault' : platform === 'win32' ? 'BitLocker' : 'LUKS';
    return { state: 'unknown', mechanism, detail: `The check could not run (${error instanceof Error ? error.message.split('\n')[0] : String(error)}).` };
  }
}
