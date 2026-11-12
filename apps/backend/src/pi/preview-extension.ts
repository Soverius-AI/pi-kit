import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { PreviewRegistrationSchema } from '@pi-kit/protocol';
import { z } from 'zod';

export const PREVIEW_TOOL = 'pi_preview';
export const PREVIEW_GUIDANCE = `Use pi_preview to publish or clear this thread's iframe preview link, including on web-only backends. Start a web project's development server first, then publish its absolute HTTP(S) sourceUrl; optionally provide a browser-reachable previewUrl and title. Publication is metadata, not proof the page loaded, is reachable on another device, or permits iframe embedding. Do not claim to have inspected it. pi_browser is a separate desktop-only native automation browser for snapshots, screenshots and interaction; it is not the iframe preview. Never supply credentials in URLs.`;

export function createPreviewExtension(options: { publish: (payload: unknown) => boolean }): ExtensionFactory {
  return (api: ExtensionAPI) => {
    api.registerTool({
      name: PREVIEW_TOOL,
      label: 'Preview',
      description:
        'Publish (op=set) or clear (op=clear) the thread iframe preview link. Metadata only; does not verify loading or reachability.',
      parameters: z.toJSONSchema(PreviewRegistrationSchema, {
        target: 'draft-7',
      }) as unknown as ToolDefinition['parameters'],
      executionMode: 'sequential',
      async execute(_id, input) {
        const registration = PreviewRegistrationSchema.parse(input);
        if (!options.publish(registration)) throw new Error('Preview publication was rejected.');
        return {
          content: [
            {
              type: 'text',
              text: registration.op === 'clear' ? 'Preview cleared.' : 'Preview link published (not load-verified).',
            },
          ],
          details: registration,
        };
      },
    });
    api.on('before_agent_start', (event) => {
      if (api.getActiveTools().includes(PREVIEW_TOOL))
        event.systemPromptOptions.sections['pi_kit_preview'] = PREVIEW_GUIDANCE;
      else delete event.systemPromptOptions.sections['pi_kit_preview'];
    });
  };
}
