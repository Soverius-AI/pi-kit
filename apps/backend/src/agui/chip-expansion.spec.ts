import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ComposerChip } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { type ChipResources, expandChips, parseCommandArgs, substituteArgs, takesArguments } from './chip-expansion';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = `${here}/fixtures/skills`;
const fixture = (name: string): string => readFileSync(`${here}/fixtures/${name}`, 'utf8').replaceAll('{{ROOT}}', ROOT);

// pi's own front-matter stripper, the same function the backend hands over (`pi.stripFrontmatter`).
const piRoot = fileURLToPath(new URL('../../../../node_modules/@earendil-works/pi-coding-agent/dist/', import.meta.url));
const pi = await import('@earendil-works/pi-coding-agent');
const templates = (await import(pathToFileURL(`${piRoot}core/prompt-templates.js`).href)) as {
  expandPromptTemplate(text: string, list: { name: string; content: string }[]): string;
};

const skill = (name: string) => ({ name, filePath: `${ROOT}/${name}/SKILL.md`, baseDir: `${ROOT}/${name}` });
const TEMPLATES = [
  { name: 'plain', content: 'Review the staged changes and list anything that looks risky.' },
  { name: 'greet', content: 'Greet $1 and then say $2, or "${2:-nothing}" if there is nothing. Everything: $@' },
  { name: 'rest', content: 'First: $1. The rest: ${@:2}' },
];
const resources: ChipResources = {
  skills: [skill('alpha'), skill('beta')],
  templates: TEMPLATES,
  read: (path) => readFileSync(path, 'utf8'),
  stripFrontmatter: pi.stripFrontmatter,
};
const chip = (kind: ComposerChip['kind'], name: string, pinned = false): ComposerChip => ({ kind, name, pinned });

/** What pi's own `_expandSkillCommand` makes of a typed `/skill:` message in this folder: the method is called on a stand-in session. */
function piExpansion(text: string): string {
  const session = { resourceLoader: { getSkills: () => ({ skills: [skill('alpha'), skill('beta')] }) }, _extensionRunner: { emitError: () => undefined } };
  return (pi.AgentSession.prototype as unknown as { _expandSkillCommand(this: unknown, text: string): string })._expandSkillCommand.call(session, text);
}

describe('expandChips', () => {
  it('leaves a message without chips alone', () => {
    expect(expandChips([], 'just a sentence', resources)).toBe('just a sentence');
  });

  it('gives one skill chip and no text exactly what /skill:name gave, as recorded from pi 1.3', () => {
    const expanded = expandChips([chip('skill', 'alpha')], '', resources);
    expect(expanded).toBe(fixture('alpha.expansion.txt'));
    expect(expanded).toBe(piExpansion('/skill:alpha'));
  });

  it('puts the sentence after the block like the arguments of /skill:name', () => {
    const expanded = expandChips([chip('skill', 'alpha')], '  say hi ', resources);
    expect(expanded).toBe(fixture('alpha-args.expansion.txt'));
    expect(expanded).toBe(piExpansion('/skill:alpha say hi'));
  });

  it('makes one block per chip in chip order and then the sentence (three chips)', () => {
    const expanded = expandChips([chip('skill', 'beta'), chip('skill', 'alpha'), chip('prompt', 'plain')], 'do the thing', resources);
    const blocks = [piExpansion('/skill:beta'), piExpansion('/skill:alpha'), templates.expandPromptTemplate('/plain', TEMPLATES)];
    expect(expanded).toBe(`${blocks.join('\n\n')}\n\ndo the thing`);
    expect(expanded.indexOf('<skill name="beta"')).toBeLessThan(expanded.indexOf('<skill name="alpha"'));
  });

  it('expands a template as pi does and takes the sentence as its arguments when it has placeholders', () => {
    const expanded = expandChips([chip('prompt', 'greet')], 'Ada "good evening"', resources);
    expect(expanded).toBe(templates.expandPromptTemplate('/greet Ada "good evening"', TEMPLATES));
    expect(expanded).toBe('Greet Ada and then say good evening, or "good evening" if there is nothing. Everything: Ada good evening');
  });

  it('expands a template without arguments the way /name does, with the sentence after it when the template takes none', () => {
    expect(expandChips([chip('prompt', 'plain')], '', resources)).toBe(templates.expandPromptTemplate('/plain', TEMPLATES));
    expect(expandChips([chip('prompt', 'plain')], 'and be brief', resources)).toBe(`${TEMPLATES[0].content}\n\nand be brief`);
    expect(expandChips([chip('prompt', 'greet')], '', resources)).toBe(templates.expandPromptTemplate('/greet', TEMPLATES));
    expect(expandChips([chip('prompt', 'rest')], 'a b c', resources)).toBe(templates.expandPromptTemplate('/rest a b c', TEMPLATES));
  });

  it('gives the sentence to the first template that takes arguments, once, beside a skill', () => {
    const expanded = expandChips([chip('skill', 'alpha'), chip('prompt', 'greet'), chip('prompt', 'rest')], 'Ada hi', resources);
    expect(expanded).toBe(`${piExpansion('/skill:alpha')}\n\n${templates.expandPromptTemplate('/greet Ada hi', TEMPLATES)}\n\n${templates.expandPromptTemplate('/rest', TEMPLATES)}`);
  });

  it('carries a pinned chip like any other: the chips of the next message are the pinned ones plus the new ones', () => {
    const first = expandChips([chip('skill', 'alpha', true)], 'one', resources);
    const second = expandChips([chip('skill', 'alpha', true), chip('skill', 'beta')], 'two', resources);
    expect(first).toBe(`${piExpansion('/skill:alpha')}\n\none`);
    expect(second).toBe(`${piExpansion('/skill:alpha')}\n\n${piExpansion('/skill:beta')}\n\ntwo`);
  });

  it('expands a typed /skill:name that opens the sentence as one more block when chips are there, each skill once', () => {
    expect(expandChips([chip('skill', 'alpha')], '/skill:beta check', resources)).toBe(`${piExpansion('/skill:alpha')}\n\n${piExpansion('/skill:beta')}\n\ncheck`);
    expect(expandChips([chip('skill', 'alpha'), chip('skill', 'alpha')], '', resources)).toBe(piExpansion('/skill:alpha'));
    expect(expandChips([chip('skill', 'alpha')], '/skill:alpha again', resources)).toBe(`${piExpansion('/skill:alpha')}\n\nagain`);
  });

  it('leaves out a chip whose skill is gone, and the typed text is returned unchanged when nothing is left', () => {
    expect(expandChips([chip('skill', 'removed'), chip('skill', 'beta')], 'x', resources)).toBe(`${piExpansion('/skill:beta')}\n\nx`);
    expect(expandChips([chip('skill', 'removed')], '  x ', resources)).toBe('  x ');
    expect(expandChips([chip('prompt', 'removed')], '', resources)).toBe('');
  });

  it('leaves out a skill whose file cannot be read, as pi leaves the text alone', () => {
    const broken = { ...resources, read: () => { throw new Error('gone'); } };
    expect(expandChips([chip('skill', 'alpha')], 'x', broken)).toBe('x');
  });
});

describe('the copies of pi helpers', () => {
  const cases = ['', 'a b', '"a b" c', "'x y' \"\" z", '  spaced   out  '];
  const body = '$1 $2 $@ $ARGUMENTS ${1:-d} ${3:-fallback} ${@:2} ${@:2:1} ${@:-none} $9';

  it('split arguments and substitute them exactly as pi does', async () => {
    const real = (await import(pathToFileURL(`${piRoot}core/prompt-templates.js`).href)) as {
      parseCommandArgs(s: string): string[];
      substituteArgs(content: string, args: string[]): string;
    };
    for (const input of cases) {
      expect(parseCommandArgs(input)).toEqual(real.parseCommandArgs(input));
      expect(substituteArgs(body, parseCommandArgs(input))).toBe(real.substituteArgs(body, real.parseCommandArgs(input)));
    }
  });

  it('knows which templates take arguments', () => {
    expect(takesArguments('plain text with $ sign alone')).toBe(false);
    expect(takesArguments('$1')).toBe(true);
    expect(takesArguments('all: $@')).toBe(true);
    expect(takesArguments('${2:-x}')).toBe(true);
    expect(takesArguments('${@:2}')).toBe(true);
    expect(takesArguments('$ARGUMENTS')).toBe(true);
  });
});
