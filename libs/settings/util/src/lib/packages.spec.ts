import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import type { PackageItem, PackageSearchResult } from '@pi-kit/protocol';
import * as p from './packages';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const brings = (extensions = 0, skills = 0, prompts = 0, themes = 0) => ({
  extensions,
  skills,
  prompts,
  themes,
  names: { extensions: [], skills: [], prompts: [], themes: [] },
});
const item = (over: Partial<PackageItem> = {}): PackageItem => ({
  id: 'user:npm:pi-subagents',
  source: 'npm:pi-subagents',
  name: 'pi-subagents',
  version: '0.4.0',
  scope: 'user',
  origin: 'npm',
  enabled: true,
  installed: true,
  brings: brings(2, 3),
  ...over,
});

describe('words', () => {
  it('dates: short, with the year when it is another one', () => {
    expect(p.shortDate.bind(undefined, english)(Date.UTC(2026, 9, 3, 12), NOW)).toBe('Oct 3');
    expect(p.shortDate.bind(undefined, english)(Date.UTC(2025, 8, 28, 12), NOW)).toBe('Sep 28 2025');
  });
  it('how long ago', () => {
    const ago = (days: number) =>
      p.agoText.bind(undefined, english)(new Date(NOW - days * 86_400_000).toISOString(), NOW);
    expect(ago(0)).toBe('today');
    expect(ago(1)).toBe('yesterday');
    expect(ago(4)).toBe('4 days ago');
    expect(ago(15)).toBe('2 weeks ago');
    expect(ago(80)).toBe('Jul 29');
    expect(p.agoText.bind(undefined, english)('nonsense', NOW)).toBeUndefined();
    expect(p.agoText.bind(undefined, english)(undefined, NOW)).toBeUndefined();
  });
  it('downloads', () => {
    expect(p.downloadsText(12034)).toBe('12k');
    expect(p.downloadsText(3100)).toBe('3.1k');
    expect(p.downloadsText(800)).toBe('800');
  });
});

describe('packageRows', () => {
  it('says what it brings, where it is from and when it was installed', () => {
    const [row] = p.packageRows.bind(undefined, english)(
      [item({ installedAt: Date.UTC(2026, 9, 3, 12) })],
      undefined,
      NOW,
    );
    expect(row.parts).toEqual({
      brings: '2 extensions, 3 skills',
      origin: 'npm:pi-subagents',
      originMono: true,
      installed: 'installed Oct 3',
    });
    expect(row.originChip).toBe('npm');
    expect(row.outdated).toBeUndefined();
  });
  it('shows the outdated chip as 0.4 → 0.5, or in words when pi has no versions', () => {
    expect(
      p.packageRows.bind(undefined, english)([item({ outdated: { current: '0.4.0', latest: '0.5.0' } })])[0].outdated,
    ).toBe('0.4.0 → 0.5.0');
    expect(
      p.packageRows.bind(undefined, english)([item({ origin: 'git', source: 'git:github.com/x/y', outdated: {} })])[0]
        .outdated,
    ).toBe('update available');
  });
  it('a folder shows its path with ~, a bundled package says it ships with pi-kit', () => {
    expect(
      p.originText.bind(undefined, english)({ origin: 'folder', source: '../pkg', path: '/Users/me/pkg' }, '/Users/me'),
    ).toBe('~/pkg');
    expect(
      p.originText.bind(
        undefined,
        english,
      )({
        origin: 'folder',
        source: '../x',
        path: '/private/var/folders/7z/bw32tbfd2fgcs7gswbhn6bkh0000gn/T/pkgs/team-tools',
      }),
    ).toBe('…/pkgs/team-tools');
    expect(p.originText.bind(undefined, english)({ origin: 'bundled', source: '/app/packages/pi-kit-learn' })).toBe(
      'ships with pi-kit',
    );
    expect(
      p.originText.bind(
        undefined,
        english,
      )({ origin: 'git', source: 'git:github.com/someone/a-really-long-repository-name-git-guard' }),
    ).toMatch(/^git:github\.com\/someone….*git-guard$/);
  });
  it('a package that is configured but not on disk is marked', () => {
    expect(p.packageRows.bind(undefined, english)([item({ installed: false })])[0].missing).toBe(true);
  });
  it('the chip says how many are on', () => {
    expect(p.packagesOnText.bind(undefined, english)([item(), item({ id: 'b', enabled: false })])).toBe('1 of 2 on');
  });
  it('summarises', () => {
    expect(p.packagesSummary.bind(undefined, english)([])).toBe('No packages yet.');
    expect(p.packagesSummary.bind(undefined, english)([item(), item({ id: 'b', enabled: false, outdated: {} })])).toBe(
      '2 packages, 1 on, 1 update.',
    );
  });
});

describe('resultDetail', () => {
  const result: PackageSearchResult = {
    name: 'pi-subagents',
    source: 'npm:pi-subagents',
    version: '0.5.0',
    downloads: 12034,
    updated: new Date(NOW - 4 * 86_400_000).toISOString(),
    license: 'MIT',
    contains: ['extensions', 'skills'],
    exact: true,
    brings: { extensions: 2, skills: 3, prompts: 0, themes: 0 },
  };
  it('reads like the mockup', () => {
    expect(p.resultDetail.bind(undefined, english)(result, NOW)).toBe(
      '2 extensions, 3 skills · 12k downloads · updated 4 days ago · MIT',
    );
  });
  it('a guessed content says nothing of what it adds', () => {
    expect(
      p.resultDetail.bind(undefined, english)(
        { ...result, brings: undefined, exact: false, contains: ['skills'], license: undefined, downloads: undefined },
        NOW,
      ),
    ).toBe('updated 4 days ago');
  });
});

describe('the Add a package steps', () => {
  const result: PackageSearchResult = {
    name: 'pi-swarm',
    source: 'npm:pi-swarm',
    version: '1.0.0',
    contains: [],
    exact: false,
  };
  it('starts on Browse, step one, for every project', () => {
    expect(p.startAddPackage()).toMatchObject({
      tab: 'browse',
      step: 'pick',
      everyProject: true,
      query: '',
      kind: 'all',
    });
    expect(p.footHint.bind(undefined, english)(p.startAddPackage())).toBe('Step 1 of 2, next: what it adds');
    expect(p.primaryText.bind(undefined, english)(p.startAddPackage())).toBe('Continue');
  });
  it('Browse continues by picking a result', () => {
    expect(p.canContinue(p.startAddPackage())).toBe(false);
    const next = p.pickResult(p.startAddPackage(), result);
    expect(next).toMatchObject({ step: 'confirm', source: 'npm:pi-swarm', direction: 'forward' });
    expect(p.primaryText.bind(undefined, english)(next)).toBe('Install');
    expect(p.footHint.bind(undefined, english)(next)).toBe('Step 2 of 2');
    expect(p.backToPick(next)).toMatchObject({ step: 'pick', direction: 'back' });
  });
  it('From git needs an address, From a folder a path', () => {
    const git = { ...p.setTab(p.startAddPackage(), 'git'), git: 'https://github.com/x/y' };
    expect(p.canContinue({ ...git, git: 'not an address' })).toBe(false);
    expect(p.canContinue(git)).toBe(true);
    expect(p.continueTyped(git)).toMatchObject({ step: 'confirm', source: 'https://github.com/x/y' });
    const folder = p.setTab(p.startAddPackage(), 'folder');
    expect(p.canContinue(folder)).toBe(false);
    expect(p.continueTyped({ ...folder, folder: ' ~/pkg ' })).toMatchObject({ step: 'confirm', source: '~/pkg' });
    expect(p.continueTyped(folder).step).toBe('pick');
  });
  it('git sources: bare GitHub addresses become git: sources', () => {
    expect(p.gitSource('github.com/x/y')).toBe('git:github.com/x/y');
    expect(p.gitSource('git:github.com/x/y@v1')).toBe('git:github.com/x/y@v1');
    expect(p.gitSource('git@github.com:x/y.git')).toBe('git@github.com:x/y.git');
    expect(p.gitSource('/some/folder')).toBeUndefined();
    expect(p.gitSource('  ')).toBeUndefined();
  });
  it('the command is exactly what will run, with -l for this project only', () => {
    const state = p.pickResult(p.startAddPackage(), result);
    expect(p.commandOf(state, undefined)).toBe('pi install npm:pi-swarm');
    expect(p.commandOf({ ...state, everyProject: false }, undefined)).toBe('pi install -l npm:pi-swarm');
    expect(p.commandOf({ ...state, source: '~/pkg' }, { source: '/Users/me/pkg' })).toBe('pi install /Users/me/pkg');
  });
});
