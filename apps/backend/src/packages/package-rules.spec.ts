import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bringsText, installCommand } from '@pi-kit/protocol';
import { entryWithEnabled, folderOf, groupBrings, isEntryEnabled, nameOfSource, normalizeSource, originOf, resourceName, sourceIdentity } from './package-rules';

describe('sourceIdentity', () => {
  it('ignores the version of an npm package', () => {
    expect(sourceIdentity('npm:pi-subagents@0.4.2')).toBe('npm:pi-subagents');
    expect(sourceIdentity('npm:@scope/pkg@1.0.0')).toBe('npm:@scope/pkg');
    expect(sourceIdentity('npm:@scope/pkg')).toBe('npm:@scope/pkg');
  });
  it('treats every spelling of one repository as one', () => {
    const same = ['git:github.com/x/y', 'https://github.com/x/y', 'https://github.com/x/y.git', 'git@github.com:x/y.git', 'git:github.com/x/y@v1', 'ssh://git@github.com/x/y'];
    for (const source of same) expect(sourceIdentity(source), source).toBe('git:github.com/x/y');
    expect(sourceIdentity('git:github.com/x/z')).not.toBe('git:github.com/x/y');
  });
  it('resolves a folder against the base', () => {
    expect(sourceIdentity('./pkg', '/work')).toBe('folder:/work/pkg');
    expect(sourceIdentity('~/pkg')).toBe(`folder:${join(homedir(), 'pkg')}`);
    expect(sourceIdentity('/abs/pkg/')).toBe('folder:/abs/pkg');
  });
});

describe('names and origins', () => {
  it('names a package by its source when its manifest cannot', () => {
    expect(nameOfSource('npm:@scope/pkg@1')).toBe('@scope/pkg');
    expect(nameOfSource('git:github.com/x/git-guard')).toBe('git-guard');
    expect(nameOfSource('/Users/me/pkgs/my-pkg/')).toBe('my-pkg');
  });
  it('knows the ones that ship with pi-kit', () => {
    expect(originOf('/app/packages/pi-kit-learn', '@pi-kit/learn')).toBe('bundled');
    expect(originOf('/app/packages/pi-computer-use', '@pi-kit/computer-use')).toBe('bundled');
    expect(originOf('/app/packages/other', 'other')).toBe('folder');
    expect(originOf('npm:x', undefined)).toBe('npm');
    expect(originOf('https://github.com/x/y', 'y')).toBe('git');
  });
  it('turns a bare GitHub address into a git source', () => {
    expect(normalizeSource(' github.com/x/y ')).toBe('git:github.com/x/y');
    expect(normalizeSource('npm:x')).toBe('npm:x');
    expect(normalizeSource('/a/b')).toBe('/a/b');
  });
  it('folderOf expands ~ and keeps an absolute path', () => {
    expect(folderOf('~/x', '/work')).toBe(join(homedir(), 'x'));
    expect(folderOf('x', '/work')).toBe('/work/x');
    expect(folderOf('/abs', '/work')).toBe('/abs');
  });
});

describe('resourceName', () => {
  it('names a skill by its folder, an extension by its file, a prompt or theme without the extension', () => {
    expect(resourceName('skills', '/p/skills/parallel-research/SKILL.md')).toBe('parallel-research');
    expect(resourceName('extensions', '/p/extensions/subagents.ts')).toBe('subagents');
    expect(resourceName('extensions', '/p/extensions/learn/index.ts')).toBe('learn');
    expect(resourceName('extensions', '/p/extensions/index.ts')).toBe('index');
    expect(resourceName('prompts', '/p/prompts/review.md')).toBe('review');
    expect(resourceName('themes', '/p/themes/night.json')).toBe('night');
  });
});

describe('groupBrings', () => {
  const res = (path: string, source: string, scope = 'user', origin = 'package') => ({ path, metadata: { scope, origin, source } });
  it('counts what each package brings, once per file, and ignores top-level files', () => {
    const groups = groupBrings({
      extensions: [res('/a/extensions/one.ts', 'npm:a'), res('/a/extensions/one.ts', 'npm:a'), res('/a/extensions/two.ts', 'npm:a'), res('/u/ext.ts', 'local', 'user', 'top-level')],
      skills: [res('/a/skills/s1/SKILL.md', 'npm:a'), res('/b/skills/s1/SKILL.md', 'npm:b', 'project')],
      prompts: [],
      themes: [res('/b/themes/night.json', 'npm:b', 'project')],
    });
    expect([...groups.keys()].sort()).toEqual(['project:npm:b', 'user:npm:a']);
    expect(groups.get('user:npm:a')).toMatchObject({ extensions: 2, skills: 1, prompts: 0, themes: 0, names: { extensions: ['one', 'two'], skills: ['s1'] } });
    expect(groups.get('project:npm:b')).toMatchObject({ extensions: 0, skills: 1, themes: 1 });
  });
  it('says it in words', () => {
    expect(bringsText({ extensions: 2, skills: 3, prompts: 0, themes: 0 })).toBe('2 extensions, 3 skills');
    expect(bringsText({ extensions: 1, skills: 0, prompts: 1, themes: 1 })).toBe('1 extension, 1 prompt, 1 theme');
    expect(bringsText({ extensions: 0, skills: 0, prompts: 0, themes: 0 })).toBe('nothing yet');
  });
});

describe('the switch of a package', () => {
  it('off filters every kind to nothing and keeps the other fields; on takes the filters away', () => {
    const off = entryWithEnabled('npm:a', false);
    expect(off).toEqual({ source: 'npm:a', extensions: [], skills: [], prompts: [], themes: [] });
    expect(isEntryEnabled(off)).toBe(false);
    expect(isEntryEnabled('npm:a')).toBe(true);
    expect(entryWithEnabled(off, true)).toBe('npm:a');
    expect(entryWithEnabled({ source: 'npm:a', autoload: false, extensions: [], skills: [], prompts: [], themes: [] }, true)).toEqual({ source: 'npm:a', autoload: false });
  });
  it('a filter that only narrows a package is still on, and survives being switched on', () => {
    const narrowed = { source: 'npm:a', extensions: ['extensions/*.ts'], skills: [] };
    expect(isEntryEnabled(narrowed)).toBe(true);
    expect(entryWithEnabled(narrowed, true)).toEqual({ source: 'npm:a', extensions: ['extensions/*.ts'] });
  });
});

describe('the command', () => {
  it('is what pi install takes, quoted where a shell needs it', () => {
    expect(installCommand('npm:pi-subagents@0.5.0')).toBe('pi install npm:pi-subagents@0.5.0');
    expect(installCommand('npm:x', 'project')).toBe('pi install -l npm:x');
    expect(installCommand('/Users/me/my pkg')).toBe("pi install '/Users/me/my pkg'");
  });
});
