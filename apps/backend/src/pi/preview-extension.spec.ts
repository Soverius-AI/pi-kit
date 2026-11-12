import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { describe, expect, it, vi } from 'vitest';
import { createPreviewExtension } from './preview-extension';
import { createBrowserExtension } from './browser-extension';
import { UiBridge } from './ui-bridge';
import { emptyBrowserState } from '@pi-kit/protocol';
import { mapUiEvent } from '@pi-kit/pi-adapter';
import { hydrateThread } from '../agui/thread-hydration';

const mount = (factory: ReturnType<typeof createPreviewExtension>) => {
  const registerTool = vi.fn();
  factory({ registerTool, on: vi.fn() } as unknown as ExtensionAPI);
  return registerTool.mock.calls[0][0] as ToolDefinition;
};
const execute = (tool: ToolDefinition, input: unknown) =>
  tool.execute('call', input as never, new AbortController().signal, undefined, {} as never);

describe('preview publication', () => {
  it('publishes without a desktop host, deduplicates and hydrates a latest clear outside chat state', async () => {
    const bridge = new UiBridge();
    const events: ReturnType<typeof mapUiEvent>[number][] = [];
    bridge.onUnattached((event) => events.push(...mapUiEvent(event)));
    const tool = mount(createPreviewExtension({ publish: (value) => bridge.publishPreview(value) }));
    await execute(tool, { op: 'set', sourceUrl: 'http://localhost:5173' });
    await execute(tool, { op: 'set', sourceUrl: 'http://localhost:5173' });
    await execute(tool, { op: 'clear' });
    expect(events).toHaveLength(2);
    const hydration = hydrateThread(events as never);
    expect(hydration.preview).toEqual({ op: 'clear' });
    expect(hydration.state).toEqual({});
    expect(hydration.view).not.toHaveProperty('preview');
  });

  it('rejects malformed, credentialed and non-http URLs before publication', async () => {
    const bridge = new UiBridge();
    const listener = vi.fn();
    bridge.onUi(listener);
    const tool = mount(createPreviewExtension({ publish: (value) => bridge.publishPreview(value) }));
    for (const sourceUrl of ['relative', 'javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com']) {
      expect(bridge.publishPreview({ op: 'set', sourceUrl })).toBe(false);
      await expect(execute(tool, { op: 'set', sourceUrl })).rejects.toThrow();
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes native result URLs only after successful changed navigation, never on failure', async () => {
    const publish = vi.fn(() => true);
    const state = { ...emptyBrowserState('t', true), open: true, url: 'https://example.com', title: 'Example' };
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce({ state: { ...state, error: 'failed' } })
      .mockResolvedValue({ state });
    const tool = mount(createBrowserExtension({ threadId: 't', host: () => ({ available: true, run }), publish }));
    await expect(execute(tool, { action: 'navigate', url: state.url })).rejects.toThrow('failed');
    await execute(tool, { action: 'navigate', url: state.url });
    expect(publish).not.toHaveBeenCalled();
    await execute(tool, { action: 'navigate', url: state.url });
    await execute(tool, { action: 'snapshot' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ op: 'set', sourceUrl: state.url, title: 'Example' });
  });
});
