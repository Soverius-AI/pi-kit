import type { ComposerChip } from '@pi-kit/protocol';

/**
 * Skills and prompt templates as chips: the text pi would have produced for them, built by pi-kit because pi expands only one
 * leading `/skill:name` (`AgentSession._expandSkillCommand`) or `/template` (`expandPromptTemplate`) per message.
 *
 * The shapes are pi 1.3's, copied and pinned by a unit test that calls pi's own methods:
 * - a skill: `<skill name="<name>" location="<SKILL.md>">\nReferences are relative to <dir>.\n\n<body without frontmatter>\n</skill>`;
 * - a template: its body with `$1`, `$@`, `$ARGUMENTS`, `${@:2}`, `${1:-default}` replaced by the arguments.
 * One chip and no text gives exactly what `/skill:name` (or `/template`) gave. Several chips are joined by a blank line, in chip order, and the
 * person's sentence follows after a blank line, as the request. A template that has an argument placeholder takes the sentence as its
 * arguments (the first such template; the sentence is then not repeated after the blocks).
 */

export interface ChipSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface ChipTemplate {
  name: string;
  content: string;
}

export interface ChipResources {
  skills: readonly ChipSkill[];
  templates: readonly ChipTemplate[];
  /** Reads a SKILL.md. */
  read: (path: string) => string;
  /** pi's `stripFrontmatter`. */
  stripFrontmatter: (content: string) => string;
}

/** Bash-style argument splitting with quotes (pi's `parseCommandArgs`). */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let hasToken = false;
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/** Placeholders of a template: `$1`, `$@`, `$ARGUMENTS`, `${N:-d}`, `${@:-d}`, `${@:N}`, `${@:N:L}` (pi's `substituteArgs`). */
export function substituteArgs(content: string, args: readonly string[]): string {
  const allArgs = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget: string | undefined, defaultValue: string, sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
      if (defaultTarget) {
        const value = defaultTarget === '@' || defaultTarget === 'ARGUMENTS' ? allArgs : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        let start = parseInt(sliceStart, 10) - 1;
        if (start < 0) start = 0;
        if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(' ');
        return args.slice(start).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs;
      return args[parseInt(simple ?? '', 10) - 1] ?? '';
    },
  );
}

/** Does the template take arguments (does it have a placeholder)? */
export function takesArguments(content: string): boolean {
  return /\$(?:ARGUMENTS|@|\d)|\$\{(?:\d+|ARGUMENTS|@)[:}]/.test(content);
}

/** The `<skill …>` block of one skill, as pi's `_expandSkillCommand` makes it (the arguments are added by the caller). */
export function skillBlock(skill: ChipSkill, resources: Pick<ChipResources, 'read' | 'stripFrontmatter'>): string {
  const body = resources.stripFrontmatter(resources.read(skill.filePath)).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

/**
 * The prompt text of a message with chips. `typed` is what the person wrote. A chip that names something pi does not have any more
 * (a skill removed since) is left out; an empty result is the typed text unchanged.
 */
export function expandChips(chips: readonly ComposerChip[], typed: string, resources: ChipResources): string {
  const text = typed.trim();
  const parts: string[] = [];
  let spoken = false;
  let remaining = text;
  const names = new Set<string>();

  const add = (name: string, block: string): void => {
    if (names.has(name)) return;
    names.add(name);
    parts.push(block);
  };

  for (const chip of chips) {
    if (chip.kind === 'skill') {
      const skill = resources.skills.find((s) => s.name === chip.name);
      if (!skill) continue;
      try {
        add(`skill:${skill.name}`, skillBlock(skill, resources));
      } catch {
        // pi leaves the text alone when the file cannot be read; the chip is then left out the same way.
      }
    } else {
      const template = resources.templates.find((t) => t.name === chip.name);
      if (!template) continue;
      const takes = !spoken && remaining !== '' && takesArguments(template.content);
      if (takes) {
        spoken = true;
        add(`prompt:${template.name}`, substituteArgs(template.content, parseCommandArgs(remaining)));
        remaining = '';
      } else {
        add(`prompt:${template.name}`, substituteArgs(template.content, []));
      }
    }
  }

  // A sentence that opens with a typed `/skill:name` is one more skill block, as pi would expand it on its own.
  const leading = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(remaining);
  if (leading && parts.length > 0) {
    const skill = resources.skills.find((s) => s.name === leading[1]);
    if (skill) {
      try {
        add(`skill:${skill.name}`, skillBlock(skill, resources));
        remaining = (leading[2] ?? '').trim();
      } catch {
        // stays as typed
      }
    }
  }

  if (parts.length === 0) return typed;
  return remaining ? `${parts.join('\n\n')}\n\n${remaining}` : parts.join('\n\n');
}
