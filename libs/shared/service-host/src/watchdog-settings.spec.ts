import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WatchdogSettings } from './watchdog-settings';

const directories: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-watchdog-'));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('watchdog preference', () => {
  it('is off with no file, malformed data or a value other than boolean true', () => {
    const dir = scratch();
    expect(WatchdogSettings.read(dir)).toBe(false);
    for (const content of ['broken', 'null', 'true', '{}', '{"enabled":"true"}', '{"enabled":false}']) {
      writeFileSync(join(dir, 'watchdog.json'), content);
      expect(WatchdogSettings.read(dir)).toBe(false);
    }
  });

  it('persists opt-in and opt-out atomically in the profile', () => {
    const dir = join(scratch(), 'profile');
    WatchdogSettings.write(dir, true);
    expect(WatchdogSettings.read(dir)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'watchdog.json')).mode & 0o777).toBe(0o600);
    WatchdogSettings.write(dir, false);
    expect(WatchdogSettings.read(dir)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'watchdog.json'), 'utf8'))).toEqual({ enabled: false });
  });
});
