import { describe, expect, it } from 'vitest';
import { cliStoreEnvironment } from './store-env';

describe('explicit CLI invocation compatibility', () => {
  it.each([undefined, ''])('selects explicit macos for old Darwin launchers with absent/empty setting: %s', (setting) => {
    const env = { PATH: '/test/bin', ...(setting === undefined ? {} : { PI_KIT_SECRET_STORE: setting }) };
    expect(cliStoreEnvironment(env, 'darwin')).toEqual({ ...env, PI_KIT_SECRET_STORE: 'macos' });
    expect(env).not.toHaveProperty('PI_KIT_SECRET_STORE', 'macos');
  });

  it.each(['macos', 'legacy', 'memory', 'file:/test/store.json', 'none', 'unknown', ' '])('preserves explicit setting without probing any store: %s', (setting) => {
    const env = { PI_KIT_SECRET_STORE: setting };
    expect(cliStoreEnvironment(env, 'darwin')).toBe(env);
  });

  it.each(['linux', 'win32'] as const)('preserves other-platform defaults: %s', (platform) => {
    const env = {};
    expect(cliStoreEnvironment(env, platform)).toBe(env);
    const empty = { PI_KIT_SECRET_STORE: '' };
    expect(cliStoreEnvironment(empty, platform)).toBe(empty);
  });
});
