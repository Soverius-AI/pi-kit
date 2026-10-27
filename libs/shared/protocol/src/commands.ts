import { z } from 'zod';

/** The command registry served by `GET /api/threads/:id/commands`. */

export const CommandSourceSchema = z.enum(['skill', 'prompt', 'extension', 'builtin']);
/** `prompt`: the composer sends the raw text through AG-UI and pi expands it. `action`: the UI dispatches it locally. */
export const CommandKindSchema = z.enum(['prompt', 'action']);

export const CommandSchema = z.object({
  /** Without the leading slash, e.g. `skill:pdf-tools`, `review`, `compact`. */
  name: z.string(),
  description: z.string().optional(),
  source: CommandSourceSchema,
  kind: CommandKindSchema,
  argumentHint: z.string().optional(),
  /** Where it comes from, for the badge: `user`, `project`, or the extension / package name. */
  origin: z.string().optional(),
  disabled: z.boolean().optional(),
  disabledReason: z.string().optional(),
  /** Prompt templates only: the template's frontmatter has `suggested: true`, so the composer offers it as a suggestion pill. */
  suggested: z.boolean().optional(),
  /** The pill's title (`suggestion-title` in the frontmatter); the command name when absent. */
  suggestionTitle: z.string().optional(),
}).meta({ id: 'Command' });
export type Command = z.infer<typeof CommandSchema>;
export type CommandSource = z.infer<typeof CommandSourceSchema>;
