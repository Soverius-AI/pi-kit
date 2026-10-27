import { describe, expect, it } from 'vitest';
import { isLeaseActive, LEASE_TTL_MS, renewLease } from './leases';
import { ago, buildSection, computeNotices, type OtherAgent, SECTION_RULES, SECTION_TITLE } from './section';

const NOW = 10_000_000;
const minutes = (n: number) => n * 60_000;

describe('leases', () => {
  it('expire 30 minutes after the last edit', () => {
    expect(LEASE_TTL_MS).toBe(minutes(30));
    expect(isLeaseActive({ at: NOW - minutes(29) }, NOW)).toBe(true);
    expect(isLeaseActive({ at: NOW - minutes(30) }, NOW)).toBe(false);
    expect(isLeaseActive({ at: NOW - minutes(90) }, NOW)).toBe(false);
  });

  it('keep their start while they are renewed, and start over after they lapsed', () => {
    const key = { threadId: 't', cwd: '/p', path: 'a.ts' };
    const first = renewLease(undefined, key, NOW);
    expect(first).toEqual({ ...key, since: NOW, at: NOW });
    const renewed = renewLease(first, key, NOW + minutes(10));
    expect(renewed).toEqual({ ...key, since: NOW, at: NOW + minutes(10) });
    const lapsed = renewLease(renewed, key, NOW + minutes(10) + minutes(31));
    expect(lapsed.since).toBe(NOW + minutes(41));
  });
});

describe('ago', () => {
  it('says just now, minutes and hours', () => {
    expect(ago(NOW - 5_000, NOW)).toBe('just now');
    expect(ago(NOW - minutes(3), NOW)).toBe('3 min ago');
    expect(ago(NOW - minutes(95), NOW)).toBe('2 h ago');
  });
});

describe('buildSection', () => {
  const agent = (over: Partial<OtherAgent> = {}): OtherAgent => ({ title: 'Fix e2e', state: 'running', relation: 'same-folder', branch: null, files: [{ path: 'src/a.ts', at: NOW - minutes(2) }], ...over });

  it('is absent when the thread is alone, so its prompt does not change', () => {
    expect(buildSection([], NOW)).toBeUndefined();
  });

  it('lists title, state, where it works and the files it edited, then the three rules', () => {
    const text = buildSection([agent(), agent({ title: 'Reporting adapter', state: 'idle', relation: 'worktree', branch: 'pi-kit/reporting-adapter', files: [] })], NOW) as string;
    expect(text.startsWith(SECTION_TITLE)).toBe(true);
    expect(text).toContain('- "Fix e2e" (running, this same folder): edited src/a.ts (2 min ago).');
    expect(text).toContain('- "Reporting adapter" (idle, its own worktree (branch pi-kit/reporting-adapter)): no files edited in the last 30 minutes.');
    for (const rule of SECTION_RULES) expect(text).toContain(`- ${rule}`);
    expect(SECTION_RULES).toHaveLength(3);
  });

  it('says waiting for input, counts files beyond the first eight, and lists the command line without details', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, at: NOW }));
    const text = buildSection([agent({ state: 'waiting', files: many }), { title: 'pi session', state: 'terminal', relation: 'same-folder', branch: null, files: [], lastActiveAt: NOW - minutes(4) }], NOW) as string;
    expect(text).toContain('(waiting for input, this same folder)');
    expect(text).toContain('and 2 more.');
    expect(text).toContain('- pi session (pi in a terminal, this same folder, last active 4 min ago): no file details.');
  });
});

describe('computeNotices', () => {
  const lease = (path: string, at: number, title = 'Reporting adapter', threadId = 'o1') => ({ threadId, title, path, at });

  it('tells a thread that another one changed a file it read, once', () => {
    const touched = new Map([['map.ts', NOW - minutes(5)]]);
    const told = new Map<string, number>();
    const notices = computeNotices({ touched, leases: [lease('map.ts', NOW - minutes(1))], told });
    expect(notices.map((n) => n.text)).toEqual(['*Reporting adapter* changed `map.ts` since you last read it.']);
    // The caller records what it told; the same change is not announced again.
    told.set('map.ts', notices[0].at);
    expect(computeNotices({ touched, leases: [lease('map.ts', NOW - minutes(1))], told })).toEqual([]);
    // A newer change is.
    expect(computeNotices({ touched, leases: [lease('map.ts', NOW)], told })).toHaveLength(1);
  });

  it('ignores files the thread never touched and changes older than its last look', () => {
    const touched = new Map([['a.ts', NOW]]);
    expect(computeNotices({ touched, leases: [lease('b.ts', NOW + 1)], told: new Map() })).toEqual([]);
    expect(computeNotices({ touched, leases: [lease('a.ts', NOW - minutes(1))], told: new Map() })).toEqual([]);
  });

  it('gives one notice per file even when several threads changed it', () => {
    const touched = new Map([['a.ts', NOW - minutes(9)]]);
    const notices = computeNotices({ touched, leases: [lease('a.ts', NOW - minutes(2), 'One', 'o1'), lease('a.ts', NOW - minutes(1), 'Two', 'o2'), lease('a.ts', NOW, 'One', 'o1')], told: new Map() });
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toBe('*One* and *Two* changed `a.ts` since you last read it.');
    expect(notices[0].at).toBe(NOW);
  });

  it('orders notices by when the change happened', () => {
    const touched = new Map([['a.ts', 0], ['b.ts', 0]]);
    const notices = computeNotices({ touched, leases: [lease('b.ts', 20), lease('a.ts', 30)], told: new Map() });
    expect(notices.map((n) => n.path)).toEqual(['b.ts', 'a.ts']);
  });
});
