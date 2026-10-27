import { english, german } from '@pi-kit/i18n/testing';
import type { Command } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  chipKey,
  chipOfCommand,
  commandGroups,
  fileRefsOf,
  parseSlash,
  pinnedChips,
  readPinnedChips,
  withChip,
  withPinToggled,
  withoutChip,
  withoutFileRef,
  withoutSlashToken,
} from './composer-logic';

const command = (name: string, source: Command['source'], extra: Partial<Command> = {}): Command => ({
  name,
  source,
  kind: source === 'builtin' ? 'action' : 'prompt',
  ...extra,
});

describe('commandGroups', () => {
  const commands = [
    command('skill:pdf-tools', 'skill'),
    command('fix-tests', 'prompt'),
    command('review', 'extension', { origin: 'git-guard' }),
    command('session', 'builtin'),
    command('settings', 'builtin'),
  ];

  it('lists the groups in the fixed order with one item per command', () => {
    const groups = commandGroups(english, commands, '');
    expect(groups.map((g) => g.title)).toEqual(['Skills', 'Prompt templates', 'Extensions', 'Built in']);
    expect(groups[2].items[0]).toMatchObject({ id: 'review', name: '/review', badge: 'git-guard' });
  });

  it('prefers names that contain the query and falls back to the fuzzy match', () => {
    expect(commandGroups(english, commands, 'se').flatMap((g) => g.items.map((i) => i.id))).toEqual([
      'session',
      'settings',
    ]);
    expect(commandGroups(english, commands, 'sdl').flatMap((g) => g.items.map((i) => i.id))).toEqual([
      'skill:pdf-tools',
    ]);
  });

  it('marks a disabled built-in with its reason', () => {
    const [group] = commandGroups(
      english,
      [command('share', 'builtin', { disabled: true, disabledReason: 'Out of scope.' })],
      '',
    );
    expect(group.items[0]).toMatchObject({ disabled: true, title: 'Out of scope.', badge: 'not yet' });
  });
});

describe('fileRefsOf', () => {
  it('finds @paths and drops trailing punctuation', () => {
    expect(fileRefsOf('look at @src/app.ts, and @README.md.')).toEqual(['src/app.ts', 'README.md']);
    expect(fileRefsOf('mail me at a@b.c')).toEqual([]);
  });
});

describe('withoutFileRef', () => {
  it('removes the token and the space after it', () => {
    expect(withoutFileRef('look at @src/app.ts please', 'src/app.ts')).toBe('look at please');
    expect(withoutFileRef('@a.ts and @b.ts', 'a.ts')).toBe('and @b.ts');
    expect(withoutFileRef('only @a.ts', 'a.ts')).toBe('only');
  });
});

describe('parseSlash', () => {
  it('splits the command from its arguments', () => {
    expect(parseSlash('/model gpt-4')).toEqual({ name: 'model', args: 'gpt-4' });
    expect(parseSlash('/compact')).toEqual({ name: 'compact', args: '' });
    expect(parseSlash('hello /model')).toBeUndefined();
  });
});

describe('chips', () => {
  const alpha = { kind: 'skill' as const, name: 'alpha', pinned: false };
  const review = { kind: 'prompt' as const, name: 'review', pinned: false };

  it('turns a skill or template command into a chip, and nothing else', () => {
    expect(chipOfCommand(command('skill:pdf-tools', 'skill', { origin: 'project' }))).toEqual({
      kind: 'skill',
      name: 'pdf-tools',
      pinned: false,
      scope: 'project',
    });
    expect(chipOfCommand(command('fix-tests', 'prompt'))).toEqual({ kind: 'prompt', name: 'fix-tests', pinned: false });
    expect(chipOfCommand(command('review', 'extension'))).toBeUndefined();
    expect(chipOfCommand(command('compact', 'builtin'))).toBeUndefined();
  });

  it('keeps each skill or template once, in the order added; a skill and a template of one name are two chips', () => {
    const one = withChip([], alpha);
    expect(withChip(one, alpha)).toBe(one);
    expect(withChip(one, { ...alpha, kind: 'prompt' }).map(chipKey)).toEqual(['skill:alpha', 'prompt:alpha']);
    expect(withoutChip(withChip(one, review), alpha).map(chipKey)).toEqual(['prompt:review']);
  });

  it('stops at the most a message carries', () => {
    const full = Array.from({ length: 12 }, (_, i) => ({ ...alpha, name: `s${i}` }));
    expect(withChip(full, { ...alpha, name: 'one-more' })).toBe(full);
  });

  it('pins and unpins one chip; what stays after a send is the pinned ones', () => {
    const chips = withPinToggled([alpha, review], alpha);
    expect(chips.map((c) => c.pinned)).toEqual([true, false]);
    expect(pinnedChips(chips).map(chipKey)).toEqual(['skill:alpha']);
    expect(withPinToggled(chips, alpha).map((c) => c.pinned)).toEqual([false, false]);
  });

  it('takes the /query the menu completed out of the text without leaving a gap', () => {
    expect(withoutSlashToken('/skill:al', 0, 9)).toEqual({ text: '', caret: 0 });
    expect(withoutSlashToken('/skill:al and more', 0, 9)).toEqual({ text: 'and more', caret: 0 });
    expect(withoutSlashToken('use /re for the diff', 4, 7)).toEqual({ text: 'use for the diff', caret: 4 });
    expect(withoutSlashToken('use /re', 4, 7)).toEqual({ text: 'use ', caret: 4 });
  });

  it('reads the pinned chips back, drops what is not a valid list, and marks what it keeps as pinned', () => {
    const raw = JSON.stringify({
      t1: [{ kind: 'skill', name: 'alpha', pinned: false, scope: 'user' }],
      t2: [{ kind: 'nope' }],
      t3: [],
    });
    expect(readPinnedChips(raw)).toEqual({ t1: [{ kind: 'skill', name: 'alpha', pinned: true, scope: 'user' }] });
    expect(readPinnedChips('not json')).toEqual({});
    expect(readPinnedChips(null)).toEqual({});
  });
});

describe('localized command metadata', () => {
  it('translates app command descriptions and keeps command names and external descriptions executable', () => {
    const builtIn = commandGroups(german, [command('new', 'builtin')], '')[0].items[0];
    expect(builtIn.name).toBe('/new');
    expect(builtIn.description).toBe('Neue Sitzung starten');
    const extension = commandGroups(
      german,
      [command('custom', 'extension', { description: 'External command text' })],
      '',
    )[0].items[0];
    expect(extension.description).toBe('External command text');
  });
});
