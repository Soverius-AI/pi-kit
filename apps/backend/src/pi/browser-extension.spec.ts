import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { emptyBrowserState } from '@pi-kit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_GUIDANCE, BROWSER_SECTION, BROWSER_TOOL, type BrowserHook, browserSkillPath, createBrowserExtension } from './browser-extension';

afterEach(() => vi.unstubAllEnvs());

function mount(host?: BrowserHook) {
  const registerTool = vi.fn();
  const hooks = new Map<string, (event: { systemPromptOptions: { sections: Record<string, string> } }) => void>();
  const getActiveTools = vi.fn(() => [BROWSER_TOOL]);
  createBrowserExtension({ threadId: 'thread-a', host: () => host })({ registerTool, getActiveTools, on: (name: string, handler: never) => hooks.set(name, handler) } as unknown as ExtensionAPI);
  return { registerTool, hooks, getActiveTools };
}

describe('browser tool and system prompt', () => {
  it('advertises the callable browser in the system prompt, and removes the guidance if the tool is disabled', () => {
    const { registerTool, hooks, getActiveTools } = mount({ available: true, run: vi.fn() });
    expect(registerTool.mock.calls[0][0]).toMatchObject({ name: BROWSER_TOOL, executionMode: 'sequential' });
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    hooks.get('before_agent_start')?.(event);
    expect(event.systemPromptOptions.sections[BROWSER_SECTION]).toBe(BROWSER_GUIDANCE);
    expect(BROWSER_GUIDANCE).toContain('localhost');
    expect(BROWSER_GUIDANCE).toContain('same browser the user sees');
    getActiveTools.mockReturnValue([]);
    hooks.get('before_agent_start')?.(event);
    expect(event.systemPromptOptions.sections[BROWSER_SECTION]).toBeUndefined();
  });

  it('does not register or advertise a browser on a web-only backend', () => {
    for (const host of [undefined, { available: false, run: vi.fn() }]) {
      const mounted = mount(host);
      expect(mounted.registerTool).not.toHaveBeenCalled();
      expect(mounted.hooks.size).toBe(0);
    }
  });

  it('binds execution to this chat, carries cancellation and returns actual screenshot content to the model', async () => {
    const state = emptyBrowserState('thread-a', true);
    const run = vi.fn(async () => ({ state, screenshot: { data: 'png-data', mimeType: 'image/png' as const } }));
    const mounted = mount({ available: true, run });
    const tool = mounted.registerTool.mock.calls[0][0] as ToolDefinition;
    const signal = new AbortController().signal;
    const answer = await tool.execute('call-1', { action: 'screenshot' }, signal, undefined, {} as never);
    expect(run).toHaveBeenCalledWith('thread-a', { action: 'screenshot' }, signal);
    expect(answer.content).toContainEqual({ type: 'image', data: 'png-data', mimeType: 'image/png' });
    await expect(tool.execute('call-2', { action: 'navigate' }, signal, undefined, {} as never)).rejects.toThrow('url is required');
  });

  it('loads through the real pi resource loader and contributes browser knowledge to its assembled system prompt', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pk-browser-prompt-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', base);
    vi.stubEnv('PI_OFFLINE', '1');
    const pi = await import('@earendil-works/pi-coding-agent');
    const run = vi.fn(async () => ({ state: emptyBrowserState('thread-a', true), text: 'artifact-ready', screenshot: { data: 'page-pixels', mimeType: 'image/png' as const } }));
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>['session'] | undefined;
    try {
      const loader = new pi.DefaultResourceLoader({ cwd: base, agentDir: base, noExtensions: true, noSkills: true, additionalSkillPaths: [browserSkillPath()], noPromptTemplates: true, extensionFactories: [createBrowserExtension({ threadId: 'thread-a', host: () => ({ available: true, run }) })] });
      await loader.reload();
      ({ session } = await pi.createAgentSession({ cwd: base, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(base), settingsManager: pi.SettingsManager.inMemory({}) }));
      expect(session.getActiveToolNames()).toContain(BROWSER_TOOL);
      expect(loader.getSkills().skills.find((skill) => skill.name === 'pi-browser')?.description).toContain('pi_browser');
      expect(session.systemPrompt).toContain('pi-browser');
      expect(session.systemPrompt).toContain('pi_browser');
      expect(session.systemPrompt).toContain('inspect and test web projects');
      const before = await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Verify this web project' }, { cwd: base, selectedTools: [BROWSER_TOOL] });
      expect(before.systemPromptOptions.sections[BROWSER_SECTION]).toBe(BROWSER_GUIDANCE);
      const signal = new AbortController().signal;
      const tool = session.getToolDefinition(BROWSER_TOOL);
      expect(tool).toBeDefined();
      const result = await tool!.execute('loaded-call', { action: 'screenshot' }, signal, undefined, session.extensionRunner.createToolContext('loaded-call', signal));
      expect(run).toHaveBeenCalledWith('thread-a', { action: 'screenshot' }, signal);
      expect(result.content).toContainEqual({ type: 'image', data: 'page-pixels', mimeType: 'image/png' });
    } finally {
      session?.dispose();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
