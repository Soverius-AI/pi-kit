/**
 * Which skills a prompt uses. A skill reaches pi in one of two shapes, both read here from the text that is sent:
 *
 * - a **chip**: the backend expands it into pi's `<skill name="…" location="…">` block before it prompts, so the block names the file;
 * - a **typed command**: a message that opens with `/skill:name`, which pi expands itself; the name is looked up in the session's skills for the file.
 *
 * Pure, so the shapes are pinned by a unit test; `PiSessionService` calls it for every prompt, steer and follow-up and tells the listeners.
 */

export interface SkillUse {
  name: string;
  /** The `SKILL.md` pi loaded the skill from. */
  path: string;
}

const BLOCK = /<skill name="([^"\n]+)" location="([^"\n]+)">/g;
const COMMAND = /^\/skill:([^\s]+)/;

/** The skills a message uses, each once: the blocks of chips, then a leading `/skill:name` resolved with `find`. */
export function skillsUsedBy(text: string, find: (name: string) => string | undefined): SkillUse[] {
  const uses = new Map<string, SkillUse>();
  for (const match of text.matchAll(BLOCK)) uses.set(match[2], { name: match[1], path: match[2] });
  const typed = COMMAND.exec(text.trimStart());
  if (typed) {
    const path = find(typed[1]);
    if (path && !uses.has(path)) uses.set(path, { name: typed[1], path });
  }
  return [...uses.values()];
}
