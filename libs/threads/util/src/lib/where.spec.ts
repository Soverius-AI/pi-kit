import { english } from '@pi-kit/i18n/testing';
import type { ProjectGit, WorktreeSettings } from '@pi-kit/protocol';
import { thread } from '@pi-kit/testing';
import {
  recentThings,
  baseOf,
  baseOptions,
  initialPlan,
  localBranchOptions,
  nameFromMessage,
  placementOf,
  repoSlug,
  sendBlocker,
  tildePath,
  whereWords,
  type WherePlan,
} from './where';

const git = (over: Partial<ProjectGit> = {}): ProjectGit => ({
  git: true,
  branch: 'main',
  head: null,
  dirty: 3,
  branches: [
    { name: 'main', current: true, heldBy: null },
    { name: 'develop', current: false, heldBy: null },
    { name: 'pi-kit/settings-ux', current: false, heldBy: { path: '/wt/settings-ux', thread: 'Settings v2 proposal' } },
  ],
  remoteBranches: ['origin/main', 'origin/develop'],
  hasRemote: true,
  ...over,
});

const settings = (over: Partial<WorktreeSettings> = {}): WorktreeSettings => ({
  root: null,
  base: null,
  setup: null,
  defaultRoot: '/Users/me/.pi-kit/worktrees',
  git: true,
  start: 'local',
  allowBranchSwitch: true,
  carryChanges: 'ask',
  branchMode: 'named',
  branchPrefix: 'pi-kit/',
  removeFolder: 'ask',
  setupScripts: [{ id: 'node', name: 'Node', command: 'npm ci' }],
  ...over,
});

const plan = (over: Partial<WherePlan> = {}): WherePlan => ({ ...initialPlan(settings(), git()), ...over });

describe('initialPlan', () => {
  it("starts from the project's defaults", () => {
    expect(initialPlan(settings(), git())).toMatchObject({
      mode: 'local',
      carry: false,
      naming: 'named',
      setup: undefined,
      localSetup: null,
      remember: false,
    });
    expect(initialPlan(settings({ start: 'worktree', branchMode: 'detached' }), git())).toMatchObject({
      mode: 'worktree',
      naming: 'detached',
    });
    expect(initialPlan(settings({ start: 'ask' }), git()).mode).toBe('ask');
    expect(initialPlan(settings({ base: 'develop' }), git()).from).toBe('develop');
  });

  it('carries the changes when the project says always and there are some', () => {
    expect(initialPlan(settings({ carryChanges: 'always' }), git()).carry).toBe(true);
    expect(initialPlan(settings({ carryChanges: 'always' }), git({ dirty: 0 })).carry).toBe(false);
  });

  it('is Local only for a folder that is not a repository', () => {
    expect(initialPlan(settings({ start: 'worktree', git: false }), git({ git: false })).mode).toBe('local');
  });
});

describe('placementOf', () => {
  it('has nothing to apply for Local on the checked-out branch', () => {
    expect(placementOf(plan(), git(), 'hello')).toBeUndefined();
    expect(placementOf(plan({ localBranch: 'main' }), git(), 'hello')).toBeUndefined();
  });

  it('switches the checkout to another branch, makes a new branch, and runs a script', () => {
    expect(placementOf(plan({ localBranch: 'develop' }), git(), 'x')).toEqual({ local: { branch: 'develop' } });
    expect(placementOf(plan({ newBranch: 'feature/x' }), git(), 'x')).toEqual({
      local: { branch: 'feature/x', create: true },
    });
    expect(placementOf(plan({ localSetup: 'node' }), git(), 'x')).toEqual({ local: { setup: 'node' } });
  });

  it('describes a worktree: named from the first message, the base only when chosen, carry only while there are changes', () => {
    expect(placementOf(plan({ mode: 'worktree' }), git(), 'Fix the cramped row\nmore text')).toEqual({
      worktree: { carryChanges: false, name: 'Fix the cramped row' },
    });
    expect(placementOf(plan({ mode: 'worktree', carry: true, from: 'origin/main' }), git(), 'go')).toEqual({
      worktree: { base: 'origin/main', carryChanges: true, name: 'go' },
    });
    expect(placementOf(plan({ mode: 'worktree' }), git({ dirty: 0 }), 'go')).toEqual({ worktree: { name: 'go' } });
  });

  it('detaches, types a name, and picks a script or none', () => {
    expect(placementOf(plan({ mode: 'worktree', naming: 'detached', setup: null }), git({ dirty: 0 }), 'go')).toEqual({
      worktree: { branch: null, setup: null, name: 'go' },
    });
    expect(
      placementOf(
        plan({ mode: 'worktree', naming: 'typed', typed: ' feature/map ', setup: 'node' }),
        git({ dirty: 0 }),
        'go',
      ),
    ).toEqual({ worktree: { branch: 'feature/map', setup: 'node', name: 'go' } });
    expect(placementOf(plan({ mode: 'worktree', naming: 'typed', typed: '  ' }), git({ dirty: 0 }), 'go')).toEqual({
      worktree: { name: 'go' },
    });
  });

  it('applies nothing when the choice is still to be made or the folder is not a repository', () => {
    expect(placementOf(plan({ mode: 'ask' }), git(), 'x')).toBeUndefined();
    expect(placementOf(plan({ mode: 'worktree' }), git({ git: false }), 'x')).toBeUndefined();
  });

  it('names the worktree after the message without a command prefix', () => {
    expect(nameFromMessage('  /skill:review the diff ')).toBe('the diff');
    expect(nameFromMessage('')).toBeUndefined();
    expect(nameFromMessage('x'.repeat(200))?.length).toBe(80);
  });
});

describe('sendBlocker', () => {
  it('waits for a choice, and for a typed name that is empty', () => {
    expect(sendBlocker(english, plan({ mode: 'ask' }))).toMatch(/Choose where/);
    expect(sendBlocker(english, plan({ mode: 'worktree', naming: 'typed', typed: '' }))).toMatch(/Type a branch name/);
    expect(sendBlocker(english, plan({ mode: 'worktree', naming: 'typed', typed: 'x' }))).toBeUndefined();
    expect(sendBlocker(english, plan())).toBeUndefined();
  });
});

describe('the branch menu', () => {
  it('says what stays, what a switch needs, and who holds a branch', () => {
    const [main, develop, held] = localBranchOptions(english, git(), true);
    expect(main).toMatchObject({ current: true, disabled: undefined, sub: 'checked out · 3 files not committed stay' });
    expect(develop).toMatchObject({ disabled: 'stash or commit the 3 files first' });
    expect(held?.disabled).toBe('held by the worktree of “Settings v2 proposal”');
  });

  it('enables a switch with a clean tree, and disables all of them when the project turned switching off', () => {
    const clean = localBranchOptions(english, git({ dirty: 0 }), true);
    expect(clean[0]?.sub).toBe('checked out');
    expect(clean[1]).toMatchObject({ disabled: undefined, sub: 'switches the checkout' });
    expect(localBranchOptions(english, git({ dirty: 0 }), false)[1]?.disabled).toMatch(/turned off/);
  });

  it('names the folder of a worktree that has no thread', () => {
    const held = localBranchOptions(
      english,
      git({ branches: [{ name: 'x', current: false, heldBy: { path: '/wt/x', thread: null } }] }),
      true,
    )[0];
    expect(held?.disabled).toBe('held by the worktree at /wt/x');
  });

  it('offers the remote branches with "fetch first" as bases', () => {
    expect(baseOptions(english, git()).map((o) => o.label)).toEqual([
      'main',
      'develop',
      'pi-kit/settings-ux',
      'origin/main (fetch first)',
      'origin/develop (fetch first)',
    ]);
  });
});

describe('the sentences', () => {
  it('says where Local runs and what Send does', () => {
    const words = whereWords(english, plan(), git(), settings(), '/Users/me/Development/pi-kit');
    expect(words.sentence).toBe('in ~/Development/pi-kit as it is');
    expect(words.crumb).toBe('runs in this folder on main');
    expect(words.hint).toBe('Sending starts the thread in ~/Development/pi-kit on main.');
    expect(whereWords(english, plan({ localBranch: 'develop' }), git(), settings(), '/p').crumb).toBe(
      'switches to develop, runs in this folder',
    );
    expect(whereWords(english, plan({ newBranch: 'feat/x' }), git(), settings(), '/p').hint).toContain(
      'makes the branch feat/x from main',
    );
  });

  it('says where the worktree goes, its name, its base, the carried changes and the script', () => {
    const words = whereWords(
      english,
      plan({ mode: 'worktree', carry: true }),
      git(),
      settings(),
      '/Users/me/Development/pi-kit',
    );
    expect(words.sentence).toBe('a fresh checkout under ~/.pi-kit/worktrees/pi-kit/');
    expect(words.crumb).toBe('starts in a new worktree from main');
    expect(words.hint).toBe(
      'Sending makes the worktree pi-kit/<name> from main, carries 3 files of changes, runs npm ci, then starts the thread in it.',
    );
    expect(
      whereWords(
        english,
        plan({ mode: 'worktree', naming: 'detached', setup: null }),
        git({ dirty: 0 }),
        settings(),
        '/p',
      ).hint,
    ).toBe('Sending makes a detached checkout from main, then starts the thread in it.');
    expect(
      whereWords(english, plan({ mode: 'worktree', from: 'origin/main' }), git({ dirty: 0 }), settings(), '/p').crumb,
    ).toBe('starts in a new worktree from origin/main');
  });

  it('asks while the project wants the choice made each time', () => {
    expect(whereWords(english, plan({ mode: 'ask' }), git(), settings(), '/p').hint).toMatch(
      /Choose Local or Worktree/,
    );
  });

  it('writes the home folder as ~ and slugs the project name', () => {
    expect(tildePath('/Users/me/Development/pi-kit')).toBe('~/Development/pi-kit');
    expect(tildePath('/home/me')).toBe('~');
    expect(tildePath('/srv/app')).toBe('/srv/app');
    expect(repoSlug('/Users/me/Dev/Reporting API')).toBe('reporting-api');
    expect(repoSlug('/')).toBe('project');
    expect(baseOf(plan(), git())).toBe('main');
    expect(baseOf(plan({ from: 'origin/main' }), git())).toBe('origin/main');
  });
});

describe('recentThings', () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime();
  const t = (id: string, over: Partial<Parameters<typeof thread>[1]> = {}) =>
    thread(id, { cwd: '/p', messageCount: 3, archived: false, updatedAt: now - 3_600_000, ...over });

  it('offers the last thread of the project to continue, newest first, and says if it runs in a worktree', () => {
    const things = recentThings(
      english,
      [
        t('old', { title: 'Old', updatedAt: now - 9_000_000 }),
        t('new', { title: 'Settings v2 proposal', worktree: { path: '/wt', branch: 'b', base: 'main', exists: true } }),
      ],
      '/p',
      undefined,
      '',
      now,
    );
    expect(things).toEqual([
      { kind: 'thread', id: 'new', title: 'Continue “Settings v2 proposal”', sub: 'worktree · 1h' },
    ]);
  });

  it('skips the open thread, archived and empty threads, and other projects', () => {
    const things = recentThings(
      english,
      [t('open'), t('gone', { archived: true }), t('empty', { messageCount: 0 }), t('other', { cwd: '/q' })],
      '/p',
      'open',
      '',
      now,
    );
    expect(things).toEqual([]);
  });

  it('adds a draft the composer keeps, by its first line', () => {
    expect(recentThings(english, [], '/p', undefined, '  Fix the row\nmore', now)).toEqual([
      { kind: 'draft', title: 'Fix the row', sub: 'a draft you did not send' },
    ]);
    expect(recentThings(english, [t('a', { title: 'A' })], '/p', undefined, 'x'.repeat(100), now)).toHaveLength(2);
    expect(recentThings(english, [], '/p', undefined, '   ', now)).toEqual([]);
  });
});
