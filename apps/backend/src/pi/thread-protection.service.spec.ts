import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProtectionBinding } from '../db/thread-protection.repository';
import { type SandboxClient, SandboxPackage } from './thread-protection.service';
import { ThreadProtectionTesting } from './thread-protection.testing';

const cwd = resolve('/workspace/shared');
const sandboxed: ProtectionBinding = {
  version: 1,
  mode: 'sandboxed',
  generation: 1,
  experimentalWindowsAccepted: false,
};
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

class Fixture {
  readonly rows = new ThreadProtectionTesting();
  readonly clients: SandboxClient[] = [];
  readonly create = vi.fn(async (_options: { cwd: string; protectedPaths?: string[] }): Promise<SandboxClient> => {
    const client: SandboxClient = {
      state: 'active',
      exec: vi.fn(async () => ({ exitCode: 0 })),
      request: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    this.clients.push(client);
    return client;
  });
  readonly setupWindows = vi.fn(async () => undefined);
  readonly load = vi
    .spyOn(SandboxPackage, 'load')
    .mockResolvedValue({ Sandbox: { create: this.create, setupWindows: this.setupWindows } } as never);
  readonly service = this.rows.service();

  restart() {
    return this.rows.service();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', originalPlatform);
});

describe('ThreadProtectionService', () => {
  it('keeps a thread nobody changed in Bypass without loading the sandbox', async () => {
    const f = new Fixture();
    expect(f.service.status('t')).toMatchObject({ mode: 'bypass', state: 'bypass', reason: null });
    expect(await f.service.prepare('t', cwd)).toBeUndefined();
    f.service.assertHostCapability('t', 'MCP servers');
    expect(f.load).not.toHaveBeenCalled();
    expect(f.rows.bindings.size).toBe(0);
  });

  it('saves Sandboxed before its sandbox starts and refuses runs during the change', async () => {
    const f = new Fixture();
    let started!: (client: SandboxClient) => void;
    f.create.mockImplementationOnce(() => new Promise((resolve) => (started = resolve)));
    const dispose = vi.fn();
    const change = f.service.set('t', cwd, { mode: 'sandboxed' }, dispose);
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
    expect(f.rows.bindings.get('t')).toEqual(sandboxed);
    expect(f.service.status('t').state).toBe('starting');
    expect(() => f.service.assertAdmitted('t')).toThrow(/changing its protection/);
    expect(dispose).toHaveBeenCalledOnce();
    started({ state: 'active', exec: vi.fn(), request: vi.fn(), close: vi.fn(async () => undefined) });
    expect(await change).toMatchObject({ mode: 'sandboxed', state: 'active', generation: 1 });
    expect(f.create.mock.calls[0][0].protectedPaths).toEqual([resolve('/private/pi-kit-state')]);
  });

  it('gives each thread its own sandbox, even in the same folder', async () => {
    const f = new Fixture();
    f.rows.bindings.set('one', sandboxed);
    f.rows.bindings.set('two', sandboxed);
    const one = await f.service.prepare('one', cwd);
    expect(await f.service.prepare('two', cwd)).not.toBe(one);
    expect(await f.service.prepare('one', cwd)).toBe(one);
    await f.service.release('thread:one');
    expect(f.clients[0].close).toHaveBeenCalledOnce();
    expect(f.clients[1].close).not.toHaveBeenCalled();
    expect(f.rows.owners.has('thread:one')).toBe(false);
    expect(f.rows.owners.get('thread:two')).toBe('active');
  });

  it('stays Sandboxed and unavailable when the sandbox fails to start, and retries on the next run', async () => {
    const f = new Fixture();
    f.create.mockRejectedValueOnce(Object.assign(new Error('bubblewrap is missing'), { cleanupConfirmed: true }));
    expect(await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn())).toMatchObject({
      mode: 'sandboxed',
      state: 'unavailable',
      reason: 'bubblewrap is missing',
    });
    expect(() => f.service.assertHostCapability('t', 'MCP servers')).toThrow(/sandboxed thread/);
    expect(await f.service.prepare('t', cwd)).toBe(f.clients[0]);
    expect(f.service.status('t').state).toBe('active');
  });

  it('holds a thread whose failed start did not confirm cleanup until the person confirms its recovery', async () => {
    const f = new Fixture();
    f.create.mockRejectedValueOnce(new Error('supervisor connection lost'));
    expect((await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn())).state).toBe('recovery-required');
    expect(() => f.service.assertAdmitted('t')).toThrow(/did not confirm its cleanup/);
    await expect(f.service.set('t', cwd, { mode: 'bypass', confirmBypass: true }, vi.fn())).rejects.toThrow(
      /Confirm that it stopped/,
    );
    expect(
      await f.service.set('t', cwd, { mode: 'bypass', confirmBypass: true, confirmRecovery: true }, vi.fn()),
    ).toMatchObject({ mode: 'bypass', state: 'bypass', reason: null });
    expect(f.rows.owners.size).toBe(0);
  });

  it('holds a thread whose sandbox was running when the backend went away', async () => {
    const f = new Fixture();
    await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn());
    const restarted = f.restart();
    expect(restarted.status('t').state).toBe('recovery-required');
    await expect(restarted.prepare('t', cwd)).rejects.toThrow(/did not confirm its shutdown/);
    expect(f.create).toHaveBeenCalledOnce();
    expect((await restarted.set('t', cwd, { mode: 'sandboxed', confirmRecovery: true }, vi.fn())).state).toBe('active');
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it('starts again after a restart that followed a confirmed shutdown', async () => {
    const f = new Fixture();
    await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn());
    await f.service.onModuleDestroy();
    const restarted = f.restart();
    expect(restarted.status('t').state).toBe('idle');
    expect(await restarted.prepare('t', cwd)).toBe(f.clients[1]);
  });

  it('needs a confirmation to downgrade and stops only that thread’s sandbox', async () => {
    const f = new Fixture();
    await f.service.set('one', cwd, { mode: 'sandboxed' }, vi.fn());
    await f.service.set('two', cwd, { mode: 'sandboxed' }, vi.fn());
    const dispose = vi.fn();
    await expect(f.service.set('one', cwd, { mode: 'bypass' }, dispose)).rejects.toThrow(/needs a confirmation/);
    expect(dispose).not.toHaveBeenCalled();
    expect(await f.service.set('one', cwd, { mode: 'bypass', confirmBypass: true }, dispose)).toMatchObject({
      state: 'bypass',
      generation: 2,
    });
    expect(f.clients[0].close).toHaveBeenCalledOnce();
    expect(f.clients[1].close).not.toHaveBeenCalled();
  });

  it('keeps a failed shutdown for recovery instead of saving the downgrade', async () => {
    const f = new Fixture();
    await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn());
    vi.mocked(f.clients[0].close).mockRejectedValueOnce(new Error('teardown unconfirmed'));
    await expect(f.service.set('t', cwd, { mode: 'bypass', confirmBypass: true }, vi.fn())).rejects.toThrow(
      'teardown unconfirmed',
    );
    expect(f.service.binding('t').mode).toBe('sandboxed');
    expect(f.service.status('t')).toMatchObject({ state: 'recovery-required', reason: 'teardown unconfirmed' });
    expect(f.rows.owners.get('thread:t')).toBe('recovery-required');
  });

  it('needs the Windows limitations accepted once', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    const f = new Fixture();
    await expect(f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn())).rejects.toThrow(/experimental/);
    expect(f.load).not.toHaveBeenCalled();
    expect(
      await f.service.set('t', cwd, { mode: 'sandboxed', experimentalWindowsAccepted: true }, vi.fn()),
    ).toMatchObject({ state: 'experimental', experimentalWindowsAccepted: true, platform: 'win32' });
    await f.service.set('t', cwd, { mode: 'bypass', confirmBypass: true }, vi.fn());
    expect((await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn())).state).toBe('experimental');
  });

  it('asks for the Windows machine setup, runs it once and starts the sandbox again', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    const f = new Fixture();
    f.create.mockRejectedValueOnce(
      Object.assign(new Error('Sandbox user is not provisioned.'), {
        code: 'WINDOWS_SETUP_REQUIRED',
        cleanupConfirmed: true,
      }),
    );
    expect(
      await f.service.set('t', cwd, { mode: 'sandboxed', experimentalWindowsAccepted: true }, vi.fn()),
    ).toMatchObject({ state: 'setup-required', reason: 'Sandbox user is not provisioned.' });
    expect(await f.service.setupWindows('t', cwd)).toMatchObject({ state: 'experimental', reason: null });
    expect(f.setupWindows).toHaveBeenCalledOnce();
  });

  it('reports a declined Windows setup and refuses it on other platforms', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    const f = new Fixture();
    f.setupWindows.mockRejectedValueOnce(new Error('The UAC prompt was declined.'));
    await expect(f.service.setupWindows('t', cwd)).rejects.toThrow(/setup failed: The UAC prompt was declined/);
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    await expect(f.service.setupWindows('t', cwd)).rejects.toThrow(/Only Windows/);
  });

  it('refuses a change while the thread’s background agents work', async () => {
    const f = new Fixture();
    f.service.setAgentGuard((threadId) => threadId === 't');
    await expect(f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn())).rejects.toThrow(/background agents/);
    expect(f.rows.bindings.size).toBe(0);
  });

  it('starts a fork in its source’s mode with a generation of its own', async () => {
    const f = new Fixture();
    f.rows.bindings.set('source', { ...sandboxed, generation: 4 });
    f.service.copy('source', 'fork');
    f.service.copy('plain', 'other');
    expect(f.rows.bindings.get('fork')).toEqual({ ...sandboxed, generation: 0 });
    expect(f.rows.bindings.has('other')).toBe(false);
  });

  it('blocks tools of an older generation and of a sandbox that stopped', async () => {
    const f = new Fixture();
    await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn());
    f.service.assertCurrent('t', 1);
    expect(() => f.service.assertCurrent('t', 0)).toThrow(/protection changed/);
    Object.assign(f.clients[0], { state: 'unavailable', reason: 'worker exited' });
    expect(() => f.service.assertCurrent('t', 1)).toThrow('worker exited');
    expect(f.service.status('t')).toMatchObject({ state: 'unavailable', reason: 'worker exited' });
  });

  it('forgets a deleted thread’s mode and sandbox', async () => {
    const f = new Fixture();
    await f.service.set('t', cwd, { mode: 'sandboxed' }, vi.fn());
    await f.service.forgetThread('t');
    expect(f.clients[0].close).toHaveBeenCalledOnce();
    expect(f.rows.bindings.size).toBe(0);
    expect(f.rows.owners.size).toBe(0);
  });

  it('stops every sandbox at shutdown even when one fails to stop', async () => {
    const f = new Fixture();
    await f.service.set('one', cwd, { mode: 'sandboxed' }, vi.fn());
    await f.service.set('two', cwd, { mode: 'sandboxed' }, vi.fn());
    vi.mocked(f.clients[0].close).mockRejectedValueOnce(new Error('stuck'));
    await f.service.onModuleDestroy();
    expect(f.clients[1].close).toHaveBeenCalledOnce();
    expect(f.rows.owners.get('thread:one')).toBe('recovery-required');
    expect(f.rows.owners.has('thread:two')).toBe(false);
  });
});
