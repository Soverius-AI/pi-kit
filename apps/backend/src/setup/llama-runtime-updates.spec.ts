import { describe, expect, it, vi, afterEach } from 'vitest';
import { checkLlamaRuntimeUpdates, runtimeUpdateStatus } from './llama-runtime-updates';
import { localCommand } from './local-hardware.service';
import type { LocalLlamaSwapService } from './local-llama-swap.service';

vi.mock('./local-hardware.service', () => ({
  localExecutable: vi.fn(async () => undefined),
  localCommand: vi.fn(async () => 'version: 0.5.0 (build 11146, commit abc123)'),
}));
afterEach(() => vi.unstubAllGlobals());

describe('runtime update comparisons', () => {
  it('compares modern versions without treating shallow build counts as release numbers', () => {
    expect(runtimeUpdateStatus('version: 0.5.0 (build 11146, commit abc)', 'v0.7.0')).toBe('update-available');
    expect(runtimeUpdateStatus('version: 0.7.0-dev (build 1, commit abc)', 'v0.7.0')).toBe('unknown');
    expect(runtimeUpdateStatus('version: 0.7.0 (build 1, commit abc)', 'v0.7.0')).toBe('current');
    expect(runtimeUpdateStatus('version: 0.8.0-dev (build 1, commit abc)', 'v0.7.0')).toBe('newer-build');
  });
  it('supports legacy tags and refuses ambiguous comparisons', () => {
    expect(runtimeUpdateStatus('version: 11146 (abc)', 'b12000')).toBe('update-available');
    expect(runtimeUpdateStatus(undefined, 'v0.7.0')).toBe('unknown');
    expect(runtimeUpdateStatus('custom build', 'v0.7.0')).toBe('unknown');
    expect(runtimeUpdateStatus('version: 11146 (abc)', 'v0.7.0')).toBe('unknown');
  });
  it('reports an upstream failure without claiming the runtime is current', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    const swap = {
      readConfigs: async () => [{ path: '/test.yaml', models: ['a'] }],
      configFile: async () => ({ text: 'models:\n  a:\n    cmd: /isolated/llama-server\n' }),
    } as unknown as LocalLlamaSwapService;
    const result = await checkLlamaRuntimeUpdates(swap);
    expect(result.error).toBeDefined();
    expect(result.latest).toBeUndefined();
    expect(result.runtimes[0].status).toBe('unknown');
  });
  it('inspects configured runtime paths and groups models; ignores shell launchers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v0.7.0' }) })),
    );
    const swap = {
      readConfigs: async () => [{ path: '/test.yaml', models: ['a', 'b', 'shell'] }],
      configFile: async () => ({
        text: 'models:\n  a:\n    cmd: /isolated/llama-server -m a.gguf\n  b:\n    cmd: /isolated/llama-server -m b.gguf\n  shell:\n    cmd: bash -c "llama-server"\n',
      }),
    } as unknown as LocalLlamaSwapService;
    const result = await checkLlamaRuntimeUpdates(swap);
    expect(result.latest).toBe('v0.7.0');
    expect(result.runtimes).toHaveLength(1);
    expect(result.runtimes[0]).toMatchObject({
      path: '/isolated/llama-server',
      models: ['a', 'b'],
      status: 'update-available',
    });
    expect(localCommand).toHaveBeenLastCalledWith('/isolated/llama-server', ['--version'], 3000);
    await checkLlamaRuntimeUpdates(swap);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
