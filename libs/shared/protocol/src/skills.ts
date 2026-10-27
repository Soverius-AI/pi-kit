import { z } from 'zod';

/**
 * Skills and prompt templates as chips of the composer. A chip is not text: it travels beside the text in
 * `forwardedProps.skills`, the backend expands it to the text pi would have produced for `/skill:name` (or `/template`), and the session
 * records it as a `pi-kit.skills` custom entry so a reload draws the chips again instead of the expanded instructions.
 */

export const ComposerChipKindSchema = z.enum(['skill', 'prompt']);
export type ComposerChipKind = z.infer<typeof ComposerChipKindSchema>;

export const ComposerChipSchema = z.object({
  kind: ComposerChipKindSchema,
  /** The skill's name (`pdf-tools`, without `skill:`) or the template's name (`review`). */
  name: z.string().min(1).max(200),
  /** Pinned for the thread: the chip stays on the messages that follow until it is unpinned. */
  pinned: z.boolean().default(false),
  /** Where it comes from (`user`, `project`, a package name), only for the badge. */
  scope: z.string().max(100).optional(),
});
export type ComposerChip = z.infer<typeof ComposerChipSchema>;

/** The most chips one message carries. */
export const MAX_COMPOSER_CHIPS = 12;

export const ComposerChipsSchema = z.array(ComposerChipSchema).min(1).max(MAX_COMPOSER_CHIPS);

/** `pi.skills` activity (id `skills:<entryId>`, placed right after the user message it belongs to). */
export const PiSkillsContentSchema = z.object({ chips: z.array(ComposerChipSchema) });

/** The `customType` of the session entry that records the chips of a message. */
export const SKILLS_ENTRY_TYPE = 'pi-kit.skills';

/** The `data` of the `pi-kit.skills` entry: the chips and the sentence the person typed (the expanded prompt is the message after it). */
export const SkillsEntrySchema = z.object({ chips: ComposerChipsSchema, text: z.string() });
export type SkillsEntry = z.infer<typeof SkillsEntrySchema>;

/** Reads `forwardedProps.skills` (a list of chips, each name once); anything that is not a valid list is ignored (the prompt still runs). */
export function skillChipsOf(forwardedProps: unknown): ComposerChip[] {
  const raw = (forwardedProps as { skills?: unknown } | undefined)?.skills;
  const parsed = ComposerChipsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  return parsed.data.filter((chip) => {
    const key = `${chip.kind}:${chip.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
