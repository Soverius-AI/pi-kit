import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiModule } from './load-pi';
import { ThreadProtectionExtension } from './thread-protection-extension';
import { type SandboxClient, SandboxPackage, type ThreadProtectionService } from './thread-protection.service';

const ROUTED = ['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'];

class Fixture {
  readonly assertCurrent = vi.fn();
  readonly bash = { exec: vi.fn() };
  readonly toolDefinitions = vi.fn(() => ROUTED.map((name) => ({ name })));
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  readonly api = {
    registerTool: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => void this.handlers.set(event, handler)),
    getAllTools: vi.fn(() =>
      ROUTED.map((name) => ({
        name,
        sourceInfo: { path: ThreadProtectionExtension.SOURCE },
      })),
    ),
  };

  async start() {
    vi.spyOn(SandboxPackage, 'load').mockResolvedValue({
      PiSandbox: { toolDefinitions: this.toolDefinitions, operations: () => ({ bash: this.bash }) },
    } as never);
    const protection = {
      binding: () => ({ generation: 4 }),
      assertCurrent: this.assertCurrent,
    } as unknown as ThreadProtectionService;
    const created = await ThreadProtectionExtension.create({} as PiModule, {
      threadId: 'one',
      cwd: '/work',
      client: {} as SandboxClient,
      protection,
    });
    await created.factory(this.api as never);
    return created;
  }

  call(toolName: string) {
    return this.handlers.get('tool_call')!({ toolName });
  }
}

afterEach(() => vi.restoreAllMocks());

describe('ThreadProtectionExtension', () => {
  it('registers the sandboxed tools and hands out the sandboxed shell', async () => {
    const f = new Fixture();
    const { bash, tools } = await f.start();
    expect(f.api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(ROUTED);
    expect(tools).toEqual(ROUTED);
    expect(bash).toBe(f.bash);
    f.call('read');
    expect(f.assertCurrent).toHaveBeenCalledWith('one', 4);
  });

  it('refuses turns and tools once the generation is stale', async () => {
    const f = new Fixture();
    await f.start();
    f.assertCurrent.mockImplementation(() => {
      throw new Error('protection changed');
    });
    expect(() => f.handlers.get('before_agent_start')!()).toThrow('protection changed');
    expect(() => f.call('read')).toThrow('protection changed');
  });

  it('lets reviewed host tools through and blocks every other tool', async () => {
    const f = new Fixture();
    await f.start();
    expect(f.call('agent_spawn')).toBeUndefined();
    expect(f.call('ask_user')).toBeUndefined();
    expect(f.call('browser_navigate')).toMatchObject({ block: true });
    expect(f.call('custom_exec')).toMatchObject({ block: true });
  });

  it('blocks a sandboxed tool another extension replaced later', async () => {
    const f = new Fixture();
    await f.start();
    f.api.getAllTools.mockReturnValue([{ name: 'bash', sourceInfo: { path: '/project/extension.ts' } }]);
    expect(f.call('bash')).toMatchObject({ block: true, reason: expect.stringContaining('replaced') });
    expect(f.call('read')).toMatchObject({ block: true });
  });
});
