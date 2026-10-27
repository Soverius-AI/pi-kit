import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from './version';

describe('version comparison', () => {
  it('orders releases', () => {
    expect(compareVersions('1.2.0', '1.3.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
  });
  it('puts a prerelease before its release and compares prerelease parts', () => {
    expect(compareVersions('1.3.0-beta.1', '1.3.0')).toBe(-1);
    expect(compareVersions('1.3.0-beta.2', '1.3.0-beta.10')).toBe(-1);
    expect(compareVersions('1.3.0-alpha', '1.3.0-beta')).toBe(-1);
  });
  it('is undefined for text that is not a version, and then differing counts as newer, like pi', () => {
    expect(compareVersions('latest', '1.2.0')).toBeUndefined();
    expect(compareVersions('1.03.0', '1.3.0')).toBeUndefined();
    expect(isNewerVersion('nightly', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.3.0', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.1.9', '1.2.0')).toBe(false);
  });
});
