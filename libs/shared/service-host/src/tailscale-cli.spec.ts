import { describe, expect, it } from 'vitest';
import { TailscaleCli } from './tailscale-cli';

describe('phone CLI environment', () => {
  it('selects CLI mode in a Finder-style environment without adding SHLVL', () => {
    const result = TailscaleCli.environment({ HOME: '/example/home', PATH: '/usr/bin:/bin' });
    expect(result.TAILSCALE_BE_CLI).toBe('1');
    expect(result).not.toHaveProperty('SHLVL');
    expect(result.HOME).toBe('/example/home');
    expect(result.PATH).toBe('/usr/bin:/bin');
  });

  it('preserves an existing SHLVL unchanged', () => {
    expect(TailscaleCli.environment({ SHLVL: '2' }).SHLVL).toBe('2');
  });

  it('forces CLI mode even when the inherited flag disables it', () => {
    expect(TailscaleCli.environment({ TAILSCALE_BE_CLI: '0' }).TAILSCALE_BE_CLI).toBe('1');
  });

  it('returns a copy without mutating the parent environment', () => {
    const parent = Object.freeze({ HOME: '/example/home', TAILSCALE_BE_CLI: '0' });
    const result = TailscaleCli.environment(parent);
    expect(result).not.toBe(parent);
    expect(parent).toEqual({ HOME: '/example/home', TAILSCALE_BE_CLI: '0' });
    result.HOME = '/different/home';
    expect(parent.HOME).toBe('/example/home');
  });

  it('defaults to a copy of the current process environment', () => {
    const before = { ...process.env };
    const result = TailscaleCli.environment();
    expect(result).toEqual({ ...before, TAILSCALE_BE_CLI: '1' });
    expect(result).not.toBe(process.env);
    expect(process.env).toEqual(before);
  });
});
