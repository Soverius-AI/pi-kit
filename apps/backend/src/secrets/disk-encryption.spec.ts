import { describe, expect, it } from 'vitest';
import { detectDiskEncryption, parseBitlocker, parseFdesetup, parseLsblk } from './disk-encryption';

describe('FileVault', () => {
  it('reads fdesetup', () => {
    expect(parseFdesetup('FileVault is On.\n')).toMatchObject({ state: 'on', mechanism: 'FileVault' });
    expect(parseFdesetup('FileVault is Off.\n')).toMatchObject({ state: 'off', mechanism: 'FileVault' });
    expect(parseFdesetup('FileVault is Off.\nDeferred enablement appears to be active for user ada.')).toMatchObject({ state: 'off' });
    expect(parseFdesetup('')).toMatchObject({ state: 'unknown' });
  });
});

describe('LUKS', () => {
  const tree = (blockdevices: unknown) => JSON.stringify({ blockdevices });

  it('is on when a crypt device carries the root', () => {
    const out = tree([{ name: 'nvme0n1', type: 'disk', mountpoints: [null], children: [{ name: 'nvme0n1p3', type: 'part', mountpoints: [null], children: [{ name: 'luks-1', type: 'crypt', mountpoints: ['/'] }] }] }]);
    expect(parseLsblk(out)).toMatchObject({ state: 'on', mechanism: 'LUKS' });
  });

  it('is on when a crypt device carries /home and off when the root is on a plain partition', () => {
    const home = tree([{ name: 'sda', type: 'disk', children: [{ name: 'sda1', type: 'part', mountpoints: ['/'] }, { name: 'luks-home', type: 'crypt', mountpoints: ['/home'] }] }]);
    expect(parseLsblk(home)).toMatchObject({ state: 'on' });
    const plain = tree([{ name: 'sda', type: 'disk', children: [{ name: 'sda1', type: 'part', mountpoints: ['/'] }] }]);
    expect(parseLsblk(plain)).toMatchObject({ state: 'off' });
  });

  it('is unknown when lsblk shows no root (a container) or gives nothing usable, never "off"', () => {
    expect(parseLsblk(tree([]))).toMatchObject({ state: 'unknown' });
    expect(parseLsblk('not json')).toMatchObject({ state: 'unknown' });
  });
});

describe('BitLocker', () => {
  it('reads the shell property: 1 on, 0 off, 2 suspended', () => {
    expect(parseBitlocker('1\r\n')).toMatchObject({ state: 'on', mechanism: 'BitLocker' });
    expect(parseBitlocker('0')).toMatchObject({ state: 'off' });
    expect(parseBitlocker('2')).toMatchObject({ state: 'off', detail: expect.stringContaining('suspended') });
    expect(parseBitlocker('')).toMatchObject({ state: 'unknown' });
  });
});

describe('the check as a whole', () => {
  it('runs the platform’s command and says "unknown", never "off", when it cannot run', async () => {
    expect(await detectDiskEncryption('darwin', async (command) => (command.endsWith('fdesetup') ? 'FileVault is On.' : ''))).toMatchObject({ state: 'on' });
    expect(await detectDiskEncryption('linux', async () => '{"blockdevices":[{"name":"d","type":"crypt","mountpoints":["/"]}]}')).toMatchObject({ state: 'on' });
    const broken = await detectDiskEncryption('linux', async () => {
      throw new Error('spawn lsblk ENOENT');
    });
    expect(broken).toMatchObject({ state: 'unknown', mechanism: 'LUKS' });
    expect(broken.detail).toContain('ENOENT');
  });
});
