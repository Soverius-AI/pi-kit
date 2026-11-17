import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { createMapContext, mapEvent, sessionToMessages } from '@pi-kit/pi-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenUiExtension, GENUI_SECTION, genUiSkillPath } from './genui-extension';

afterEach(() => vi.unstubAllEnvs());
function mount() {
  const tools: ToolDefinition[] = [];
  const hooks = new Map<string, (event: { systemPromptOptions: { sections: Record<string, string> } }) => void>();
  const getActiveTools = vi.fn(() => ['render_a2ui', 'generateSandboxedUi']);
  createGenUiExtension()({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    getActiveTools,
    on: (name: string, handler: never) => hooks.set(name, handler),
  } as unknown as ExtensionAPI);
  return { tools, hooks, getActiveTools };
}
const execute = (tool: ToolDefinition, args: unknown) =>
  tool.execute('c1', args, new AbortController().signal, undefined, {} as never);

describe('built-in UI tools', () => {
  it('loads the tools and discoverable skill through the actual pi resource loader', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pk-ui-prompt-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', base);
    vi.stubEnv('PI_OFFLINE', '1');
    const pi = await import('@earendil-works/pi-coding-agent');
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>['session'] | undefined;
    try {
      const loader = new pi.DefaultResourceLoader({
        cwd: base,
        agentDir: base,
        noExtensions: true,
        noSkills: true,
        additionalSkillPaths: [genUiSkillPath()],
        noPromptTemplates: true,
        extensionFactories: [createGenUiExtension()],
      });
      await loader.reload();
      ({ session } = await pi.createAgentSession({
        cwd: base,
        resourceLoader: loader,
        sessionManager: pi.SessionManager.inMemory(base),
        settingsManager: pi.SettingsManager.inMemory({}),
      }));
      expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(['render_a2ui', 'generateSandboxedUi']));
      expect(loader.getSkills().skills.find((skill) => skill.name === 'pi-ui')).toBeDefined();
      expect(session.systemPrompt).toContain('pi-ui');
      const before = await session.extensionRunner.emitBeforeAgentStart(
        { messageType: 'user', prompt: 'Show a commit chart' },
        { cwd: base, selectedTools: ['render_a2ui', 'generateSandboxedUi'] },
      );
      expect(before.systemPromptOptions.sections[GENUI_SECTION]).toContain('Gather real data');
      const withoutTools = await session.extensionRunner.emitBeforeAgentStart(
        { messageType: 'user', prompt: 'Draw a class diagram' },
        { cwd: base, selectedTools: [] },
      );
      expect(withoutTools.systemPromptOptions.sections[GENUI_SECTION]).toContain('fenced mermaid');
      expect(withoutTools.systemPromptOptions.sections[GENUI_SECTION]).toContain('KaTeX');
      expect(withoutTools.systemPromptOptions.sections[GENUI_SECTION]).not.toContain('Available UI tools:');
    } finally {
      session?.dispose();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('produces a framed, data-bound v0.9 A2UI surface and rejects broken references', async () => {
    const tool = mount().tools[0];
    const args = {
      surfaceId: 'commits',
      title: 'Commits per day',
      body: 'table',
      components: [
        {
          id: 'table',
          component: 'Table',
          properties: { columns: [{ key: 'commits', label: 'Commits' }], rows: { path: '/rows' } },
        },
      ],
      data: { rows: [{ commits: 3 }] },
    };
    const result = await execute(tool, args);
    expect(result.details).toMatchObject({
      a2ui_operations: [
        { version: 'v0.9', createSurface: { surfaceId: 'commits' } },
        {
          updateComponents: {
            components: [
              { id: 'root', component: 'Card', child: 'table' },
              { id: 'table', component: 'Table' },
            ],
          },
        },
        { updateDataModel: { path: '/', value: args.data } },
      ],
    });
    await expect(execute(tool, { ...args, body: 'missing' })).rejects.toThrow(/body/);
    await expect(
      execute(tool, {
        ...args,
        components: [{ id: 'table', component: 'Column', properties: { children: ['missing'] } }],
      }),
    ).rejects.toThrow(/Unknown child/);
    await expect(
      execute(tool, { ...args, components: [{ id: 'root', component: 'Text', properties: { text: 'x' } }] }),
    ).rejects.toThrow(/reserve root/);
  });

  it('emits completed Open UI and restores identical content from the persisted result', async () => {
    const args = {
      initialHeight: 360,
      css: 'svg { width: 100% }',
      html: '<head></head><body><svg aria-label="Commit chart"></svg></body>',
      jsExpressions: ['document.body.dataset.ready = "yes"'],
    };
    const result = await execute(mount().tools[1], args);
    const events = mapEvent(
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'generateSandboxedUi', args, result, isError: false },
      createMapContext({ threadId: 't', runId: 'r' }),
    );
    const live = events.find(
      (event) =>
        event.type === EventType.ACTIVITY_SNAPSHOT &&
        (event as { activityType?: string }).activityType === 'open-generative-ui',
    );
    expect(live).toMatchObject({
      messageId: 'c1-activity',
      content: { html: [args.html], generating: false, htmlComplete: true, jsExpressions: args.jsExpressions },
    });
    expect(events.every((event) => EventSchemas.safeParse(event).success)).toBe(true);
    const restored = sessionToMessages([
      {
        type: 'message',
        id: 'a',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'generateSandboxedUi', arguments: args }],
        },
      },
      {
        type: 'message',
        id: 'r',
        message: { role: 'toolResult', toolCallId: 'c1', toolName: 'generateSandboxedUi', ...result, isError: false },
      },
    ]).find((message) => message.role === 'activity' && message.activityType === 'open-generative-ui');
    expect(restored).toMatchObject({ id: 'c1-activity', content: (live as unknown as { content: unknown }).content });
    await expect(execute(mount().tools[1], { html: '' })).rejects.toThrow();
  });

  it('bundles native diagram examples and security guidance without replacing UI contracts', () => {
    const skill = readFileSync(genUiSkillPath(), 'utf8');
    for (const syntax of ['flowchart LR', 'flowchart TD', 'sequenceDiagram', 'classDiagram', 'gantt']) {
      expect(skill).toContain(`\x60\x60\x60mermaid\n${syntax}`);
    }
    for (const hint of [
      'dateFormat YYYY-MM-DD',
      'after req',
      '2027-01-11',
      'illustrative dates',
      '"0..*"',
      '%%{init...}%%',
      'YAML frontmatter',
      '`click`, `link`, `links`, or `callback`',
      '@{...}',
      'classDef',
      'linkStyle',
      'url()',
      '@import',
      '@font-face',
      '`properties` and `details`',
      '50,000 source characters and 500 edges',
      '## Open Generative UI',
      '## A2UI',
      'WebSandbox',
      'ask_user',
    ]) {
      expect(skill).toContain(hint);
    }
  });

  it('advertises native Markdown even without UI tools and only names enabled tools', () => {
    const { getActiveTools, hooks } = mount();
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    getActiveTools.mockReturnValue(['render_a2ui']);
    hooks.get('before_agent_start')?.(event);
    expect(event.systemPromptOptions.sections[GENUI_SECTION]).toContain('Available UI tools: render_a2ui.');
    getActiveTools.mockReturnValue([]);
    hooks.get('before_agent_start')?.(event);
    const native = event.systemPromptOptions.sections[GENUI_SECTION];
    expect(native).toContain('fenced mermaid');
    expect(native).toContain('KaTeX math ($...$ inline, $$...$$ display)');
    expect(native).toContain('no UI tool, HTML file, or CDN needed');
    expect(native).toContain('bundled pi-ui skill');
    expect(native).toContain('Generated UI tools are disabled');
    expect(native).not.toContain('Available UI tools:');
    expect(native).not.toContain('Prefer render_a2ui');
  });
});
