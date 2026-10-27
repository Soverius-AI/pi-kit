import { english, german } from '@pi-kit/i18n/testing';
import type { TreeRow } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { footPath, pathCrumbs, treeSummary } from './tree-model';
import { row, treeOf as tree } from './test-rows';

describe('summaries', () => {
  it('says "11 turns, 2 forks" and nothing about forks when there are none', () => {
    expect(treeSummary(english, { turns: 11, forks: 2 })).toBe('11 turns, 2 forks');
    expect(treeSummary(english, { turns: 1, forks: 0 })).toBe('1 turn');
    expect(treeSummary(english, { turns: 3, forks: 1 })).toBe('3 turns, 1 fork');
    expect(treeSummary(german, { turns: 3, forks: 1 })).toBe('3 Runden, 1 Abzweigung');
  });
});

describe('pathCrumbs', () => {
  it('lists the fork points of the active path and the current turn', () => {
    const { crumbs, note } = pathCrumbs(
      english,
      tree([
        row({ id: 'root', kind: 'root', turn: null, number: '' }),
        row({ id: 't1', turn: 1 }),
        row({ id: 't2', turn: 2, childCount: 2 }),
        row({ id: 'alt', turn: 3, lane: 1, onActivePath: false, number: '3a' }),
        row({ id: 't3', turn: 3 }),
        row({ id: 't4', turn: 4, isLeaf: true, childCount: 0 }),
        row({ id: 'ghost', kind: 'ghost', turn: null }),
      ]),
    );
    expect(crumbs.map((c) => [c.label, c.tone])).toEqual([
      ['main', 'default'],
      ['fork at turn 3', 'info'],
      ['turn 4, current', 'default'],
    ]);
    expect(note).toBe('2 turns since the last fork');
  });
  it('folds earlier forks into a count when there are many', () => {
    const rows: TreeRow[] = [row({ id: 'root', kind: 'root', turn: null })];
    for (let i = 1; i <= 5; i++) rows.push(row({ id: `t${i}`, turn: i, childCount: 2 }));
    rows.push(row({ id: 't6', turn: 6, isLeaf: true, childCount: 0 }), row({ id: 'ghost', kind: 'ghost', turn: null }));
    const { crumbs } = pathCrumbs(english, tree(rows));
    expect(crumbs.map((c) => c.label)).toEqual([
      'main',
      '3 earlier forks',
      'fork at turn 5',
      'fork at turn 6',
      'turn 6, current',
    ]);
  });
  it('does not call the leaf a fork on the way to the current turn', () => {
    const { crumbs, note } = pathCrumbs(
      english,
      tree([
        row({ id: 'root', kind: 'root', turn: null }),
        row({ id: 't1', turn: 1, isLeaf: true, childCount: 2 }),
        row({ id: 'ghost', kind: 'ghost', turn: null }),
      ]),
    );
    expect(crumbs.map((c) => c.label)).toEqual(['main', 'turn 1, current']);
    expect(note).toBe('');
  });
  it('has no fork crumb and no note for a straight session', () => {
    const { crumbs, note } = pathCrumbs(
      english,
      tree([row({ id: 'root', kind: 'root', turn: null }), row({ id: 't1', turn: 1, isLeaf: true, childCount: 0 })]),
    );
    expect(crumbs.map((c) => c.label)).toEqual(['main', 'turn 1, current']);
    expect(note).toBe('');
  });
});

describe('footPath', () => {
  it('is main and the nearest fork on the way to the current turn, as the foot of the panel shows them', () => {
    const rows = [
      row({ id: 'root', kind: 'root', turn: null }),
      row({ id: 't1', turn: 1, childCount: 2 }),
      row({ id: 't2', turn: 2, isLeaf: true, childCount: 0 }),
      row({ id: 'ghost', kind: 'ghost', turn: null }),
    ];
    expect(footPath(english, tree(rows))).toBe('main › fork at turn 2');
    expect(footPath(english, undefined)).toBe('main');
  });
});
