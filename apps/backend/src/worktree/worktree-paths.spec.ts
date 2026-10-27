import { describe, expect, it } from 'vitest';
import { branchName, DEFAULT_WORKTREE_ROOT, localBaseName, normalizePrefix, repoSlug, worktreeNames, resolveBase, resolveRoot, slugify, threadSlug, uniqueSlug, worktreePath } from './worktree-paths';

describe('slugify', () => {
  it('lowers case, folds accents and turns every other run into one dash', () => {
    expect(slugify('Fix the e2e tests!')).toBe('fix-the-e2e-tests');
    expect(slugify('  Café   déjà / vu  ')).toBe('cafe-deja-vu');
    expect(slugify('___')).toBe('');
  });

  it('cuts at the limit without leaving a trailing dash', () => {
    const slug = slugify('word '.repeat(30), 12);
    expect(slug.length).toBeLessThanOrEqual(12);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('names', () => {
  it('names the repository folder after the project', () => {
    expect(repoSlug('/Users/me/Dev/Reporting API')).toBe('reporting-api');
    expect(repoSlug('/')).toBe('project');
  });

  it('takes the thread slug from the title, else from the id', () => {
    expect(threadSlug('Reporting adapter', 'e1d2c3b4-0000')).toBe('reporting-adapter');
    expect(threadSlug(undefined, 'E1D2C3B4-aaaa-bbbb')).toBe('thread-e1d2c3b4');
    expect(threadSlug('???', 'abcdef0123456789')).toBe('thread-abcdef01');
  });

  it('puts branches under pi-kit/ and folders under <root>/<repo>/<thread>', () => {
    expect(branchName('fix-e2e')).toBe('pi-kit/fix-e2e');
    expect(worktreePath('/w', '/p/My Repo', 'fix-e2e')).toBe('/w/my-repo/fix-e2e');
  });

  it('adds a number to a name that is taken', () => {
    const taken = new Set(['a', 'a-2']);
    expect(uniqueSlug('a', (c) => taken.has(c))).toBe('a-3');
    expect(uniqueSlug('b', (c) => taken.has(c))).toBe('b');
  });
});

describe('resolveRoot', () => {
  const home = '/home/me';
  it('prefers the project setting, then PI_KIT_WORKTREE_ROOT, then ~/.pi-kit/worktrees', () => {
    expect(resolveRoot({ setting: '/srv/wt', env: { PI_KIT_WORKTREE_ROOT: '/env' }, home })).toBe('/srv/wt');
    expect(resolveRoot({ setting: '  ', env: { PI_KIT_WORKTREE_ROOT: '/env/root' }, home })).toBe('/env/root');
    expect(resolveRoot({ env: {}, home })).toBe('/home/me/.pi-kit/worktrees');
    expect(DEFAULT_WORKTREE_ROOT).toBe('~/.pi-kit/worktrees');
  });

  it('expands ~ and resolves a relative setting against the project folder', () => {
    expect(resolveRoot({ setting: '~/trees', env: {}, home })).toBe('/home/me/trees');
    expect(resolveRoot({ setting: '../wt', env: {}, home, projectCwd: '/work/app' })).toBe('/work/wt');
  });
});

describe('resolveBase', () => {
  it('uses the request, then the project setting, then the checked-out branch', () => {
    expect(resolveBase({ requested: 'release', setting: 'develop', current: 'main' })).toBe('release');
    expect(resolveBase({ setting: 'develop', current: 'main' })).toBe('develop');
    expect(resolveBase({ current: 'main' })).toBe('main');
    expect(resolveBase({ current: null })).toBeUndefined();
  });
});

describe('the naming of a new worktree', () => {
  it('uses the prefix the project sets, and a slash after a word', () => {
    expect(branchName('fix', 'feat/')).toBe('feat/fix');
    expect(normalizePrefix(undefined)).toBe('pi-kit/');
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix('  wolf ')).toBe('wolf/');
    expect(normalizePrefix('/feat-')).toBe('feat-');
    expect(normalizePrefix('my team')).toBe('my-team/');
  });

  it('names a branch from the first message, then the title, then the thread id', () => {
    const named = worktreeNames({ name: 'Fix the cramped row!', title: 'Ignored', threadId: 'abcdef0123', prefix: 'pi-kit/' });
    expect(named.slug).toBe('fix-the-cramped-row');
    expect(named.branch(named.slug)).toBe('pi-kit/fix-the-cramped-row');
    expect(named.branch('fix-the-cramped-row-2')).toBe('pi-kit/fix-the-cramped-row-2');
    expect(worktreeNames({ title: 'Reporting adapter', threadId: 'x' }).slug).toBe('reporting-adapter');
    expect(worktreeNames({ threadId: 'ABCDEF0123456789' }).slug).toBe('thread-abcdef01');
  });

  it('keeps a typed branch exactly and makes the folder from its slug', () => {
    const typed = worktreeNames({ typed: 'feature/Map Rows', threadId: 'x', prefix: 'pi-kit/' });
    expect(typed.slug).toBe('feature-map-rows');
    expect(typed.branch(typed.slug)).toBe('feature/Map Rows');
  });

  it('has no branch when detached, and the folder is named all the same', () => {
    const detached = worktreeNames({ name: 'Try an idea', threadId: 'x', detached: true });
    expect(detached.slug).toBe('try-an-idea');
    expect(detached.branch(detached.slug)).toBeNull();
  });

  it('merges back into the local branch of an origin base', () => {
    expect(localBaseName('origin/main')).toBe('main');
    expect(localBaseName('develop')).toBe('develop');
  });
});
