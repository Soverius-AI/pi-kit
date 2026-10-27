import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { z } from 'zod';

const AskUserSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(12).optional().describe('Choices for a select dialog. Omit to ask for free text.'),
}).strict();

/** Uses the same pi UI promises as extensions: PiAgent reports a standard AG-UI interrupt and resumes the waiting tool. */
export function createAskUserExtension(): ExtensionFactory {
  return (api: ExtensionAPI) => api.registerTool({
    name: 'ask_user', label: 'Ask user',
    description: 'Ask the user a necessary clarification and wait for their answer through the chat interrupt UI. Include options for a choice, or omit them for free text. Use when missing information prevents useful progress.',
    promptSnippet: 'Ask for required missing information through an interactive question and wait for the user to answer.',
    parameters: z.toJSONSchema(AskUserSchema, { target: 'draft-7' }) as unknown as ToolDefinition['parameters'],
    executionMode: 'sequential',
    async execute(_id, input, signal, _update, ctx) {
      const { question, options } = AskUserSchema.parse(input);
      const value = options ? await ctx.ui.select(question, options, { signal }) : await ctx.ui.input(question, undefined, { signal });
      return { content: [{ type: 'text', text: value === undefined ? 'The user cancelled the question. No answer was provided.' : `User answered: ${value}` }], details: { cancelled: value === undefined, ...(value !== undefined ? { value } : {}) } };
    },
  });
}
