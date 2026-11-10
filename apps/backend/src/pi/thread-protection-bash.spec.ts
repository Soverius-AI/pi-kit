import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiteLlmService } from '../setup/litellm.service';
import type { PiPluginService } from './pi-plugin.service';
import { PiSessionService } from './pi-session.service';
import type { ThreadProtectionService } from './thread-protection.service';
import type { TrustService } from './trust.service';

const lifecycle = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./session-lifecycle', () => ({
  SessionLifecycle: class {
    get = lifecycle.get;
  },
}));

class Fixture {
  readonly assertAdmitted = vi.fn();
  readonly result = { output: 'done', exitCode: 0, cancelled: false, truncated: false };
  readonly executeBash = vi.fn(async () => this.result);
  readonly service = new PiSessionService(
    {} as TrustService,
    {} as PiPluginService,
    {} as LiteLlmService,
    { assertAdmitted: this.assertAdmitted } as unknown as ThreadProtectionService,
  );

  open(bash?: { exec: () => void }) {
    lifecycle.get.mockReturnValue({ session: { executeBash: this.executeBash }, bash });
  }
}

beforeEach(() => vi.resetAllMocks());

describe('PiSessionService.executeBash', () => {
  it('runs a sandboxed thread’s `!command` through its sandboxed shell', async () => {
    const f = new Fixture();
    const bash = { exec: vi.fn() };
    f.open(bash);
    const onChunk = vi.fn();
    expect(await f.service.executeBash('t', 'pwd', onChunk, true)).toBe(f.result);
    expect(f.executeBash).toHaveBeenCalledWith('pwd', onChunk, { excludeFromContext: true, operations: bash });
  });

  it('leaves a Bypass thread on pi’s own shell', async () => {
    const f = new Fixture();
    f.open();
    await f.service.executeBash('t', 'pwd', vi.fn());
    expect(f.executeBash).toHaveBeenCalledWith('pwd', expect.any(Function), { excludeFromContext: false });
  });

  it('never runs the command of a thread that is not admitted', async () => {
    const f = new Fixture();
    f.open({ exec: vi.fn() });
    f.assertAdmitted.mockImplementation(() => {
      throw new Error('recovery needed');
    });
    await expect(f.service.executeBash('t', 'pwd', vi.fn())).rejects.toThrow('recovery needed');
    expect(f.executeBash).not.toHaveBeenCalled();
  });
});
