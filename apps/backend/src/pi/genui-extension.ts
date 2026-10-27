import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GenerateSandboxedUiSchema, OPEN_GENERATIVE_UI_TOOL, RenderA2uiSchema } from '@pi-kit/protocol';
import { z } from 'zod';

export const GENUI_SKILL_KEY = 'skills:user:builtin:pi-kit-ui';
export const GENUI_SECTION = 'pi_kit_ui';
export function genUiSkillPath(): string {
  const paths = [join(__dirname, 'assets', 'skills', 'pi-ui', 'SKILL.md'), join(__dirname, '..', 'assets', 'skills', 'pi-ui', 'SKILL.md')];
  const path = paths.find((path) => existsSync(path));
  if (!path) throw new Error('The bundled pi-ui skill is missing from this installation.');
  return path;
}

const parameters = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7' }) as unknown as ToolDefinition['parameters'];

/** Built-in pi tools: their results persist in the session, and CopilotKit renders the resulting activities. */
export function createGenUiExtension(): ExtensionFactory {
  return (api: ExtensionAPI) => {
    api.registerTool({
      name: 'render_a2ui', label: 'Render A2UI',
      description: 'Display a native interactive A2UI interface inline in this chat: tables, cards, forms and buttons. Read the bundled pi-ui skill for component properties and actions.',
      promptSnippet: 'Render interactive tables, forms and cards inline using the A2UI component catalog.',
      parameters: parameters(RenderA2uiSchema), executionMode: 'sequential',
      async execute(_id, input) {
        const { surfaceId, title, body, components, data } = RenderA2uiSchema.parse(input);
        const ids = new Set(components.map((c) => c.id));
        if (ids.has('root') || ids.size !== components.length || !ids.has(body)) throw new Error('Use unique component ids, include the body component, and reserve root for pi-kit.');
        for (const { properties } of components) {
          if ('id' in properties || 'component' in properties) throw new Error('properties must not override id or component.');
          const children = properties['children'];
          const child = properties['child'];
          for (const ref of [...(Array.isArray(children) ? children : []), ...(typeof child === 'string' ? [child] : [])]) {
            if (typeof ref === 'string' && !ids.has(ref)) throw new Error(`Unknown child component: ${ref}`);
          }
        }
        const operations = [
          { version: 'v0.9', createSurface: { surfaceId, catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json' } },
          { version: 'v0.9', updateComponents: { surfaceId, components: [
            { id: 'root', component: 'Card', child: body, title },
            ...components.map(({ id, component, properties }) => ({ ...properties, id, component })),
          ] } },
          { version: 'v0.9', updateDataModel: { surfaceId, path: '/', value: Object.keys(data).length ? data : { ready: true } } },
        ];
        return { content: [{ type: 'text', text: `Displayed ${title} inline as A2UI. Buttons send user actions back to you; do not duplicate the interface in prose.` }], details: { a2ui_operations: operations } };
      },
    });
    api.registerTool({
      name: OPEN_GENERATIVE_UI_TOOL, label: 'Generate UI',
      description: 'Display a custom interactive HTML/CSS/JavaScript visualization inline in this chat using an isolated JetBrains WebSandbox iframe. Use for charts, dashboards, diagrams and simulations. Read the bundled pi-ui skill.',
      promptSnippet: 'Generate charts, dashboards and interactive visualizations inline using sandboxed HTML/CSS/JavaScript.',
      parameters: parameters(GenerateSandboxedUiSchema), executionMode: 'sequential',
      async execute(_id, input) {
        const args = GenerateSandboxedUiSchema.parse(input);
        return { content: [{ type: 'text', text: 'Displayed the generated interface inline in this chat. Do not repeat its source code or create a separate HTML file unless requested.' }], details: { open_generative_ui: args } };
      },
    });
    api.on('before_agent_start', (event) => {
      const active = api.getActiveTools();
      const tools = ['render_a2ui', OPEN_GENERATIVE_UI_TOOL].filter((tool) => active.includes(tool));
      if (tools.length) event.systemPromptOptions.sections[GENUI_SECTION] = `This chat can display generated UI. Available UI tools: ${tools.join(', ')}. Read the bundled pi-ui skill when a request benefits from an interface. Prefer render_a2ui for catalog-based tables/forms/cards, and generateSandboxedUi for custom charts, dashboards and interactive visuals. Gather real data with your tools first, then render it inline. The iframe cannot access Git, the filesystem, or pi-kit credentials; embed the collected data. UI generation does not require creating an HTML file.`;
      else delete event.systemPromptOptions.sections[GENUI_SECTION];
    });
  };
}
