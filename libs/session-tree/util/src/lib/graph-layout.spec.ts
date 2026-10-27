import { english } from '@pi-kit/i18n/testing';
import type { TreeRow } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  contextTitle,
  edgeSelection,
  formatClock,
  highlight,
  layoutGraph,
  modelLine,
  positionLine,
  rowMatches,
  stepSelection,
  subTail,
} from './graph-layout';
import { row, treeOf } from './test-rows';

/**
 * The session of mockup 02: a compaction after turn 2, two abandoned branches off turn 3 (A with two turns and a summary, C with
 * one), the active path 4 to 7 with a ghost after the leaf.
 */
function demo(): TreeRow[] {
  return [
    row({ id: 'root', kind: 'root', turn: null, number: '', preview: 'Start', parentId: null, up: false }),
    row({
      id: 't1',
      parentId: 'root',
      turn: 1,
      number: '1',
      preview: 'Map tool_execution events',
      sub: [
        { name: 'read', target: 'map.ts' },
        { name: 'edit', target: 'map.ts' },
      ],
    }),
    row({ id: 't2', parentId: 't1', turn: 2, number: '2', preview: 'Add tests per event type' }),
    row({
      id: 'c1',
      parentId: 't2',
      kind: 'compaction',
      turn: null,
      number: '',
      preview: 'Compacted, 51k tokens summarised',
    }),
    row({
      id: 't3',
      parentId: 'c1',
      turn: 3,
      number: '3',
      preview: 'Try the generator approach',
      forks: [1, 2],
      childCount: 3,
    }),
    row({
      id: 'a1',
      parentId: 't3',
      turn: 4,
      number: '4a',
      preview: 'Fix the generator typing',
      lane: 1,
      onActivePath: false,
      run: 'a1',
      group: 'a1',
      groupLetter: 'A',
      summary: 'Generator typing fixed, then abandoned',
      time: '2026-10-15T10:52:00.000Z',
    }),
    row({
      id: 'a2',
      parentId: 'a1',
      turn: 5,
      number: '5a',
      preview: 'Run the specs',
      lane: 1,
      onActivePath: false,
      run: 'a1',
      group: 'a1',
      groupLetter: 'A',
    }),
    row({
      id: 'c2',
      parentId: 't3',
      turn: 4,
      number: '4b',
      preview: 'Use opus instead',
      lane: 2,
      onActivePath: false,
      run: 'c2',
      group: 'c2',
      groupLetter: 'C',
    }),
    row({ id: 't4', parentId: 't3', turn: 4, number: '4', preview: 'Use an Observable instead', label: 'good-path' }),
    row({ id: 't5', parentId: 't4', turn: 5, number: '5', preview: 'Wire the interrupt for dialogs' }),
    row({
      id: 't6',
      parentId: 't5',
      turn: 6,
      number: '6',
      preview: 'Three specs added',
      isLeaf: true,
      contextPct: 88,
      contextTokens: 231_000,
      contextWindow: 262_144,
    }),
    row({ id: 'ghost', parentId: 't6', kind: 'ghost', turn: null, number: '', preview: 'Next turn goes here' }),
  ];
}

const keys = (rows: TreeRow[], view: Partial<Parameters<typeof layoutGraph>[2]> = {}) =>
  layoutGraph(english, treeOf(rows), { fold: true, expanded: new Set(), query: '', ...view }).items.map((i) => i.key);

describe('layoutGraph, folded', () => {
  it('shows one group row per abandoned branch, in the place of its first turn', () => {
    expect(keys(demo())).toEqual([
      'row:root',
      'row:t1',
      'row:t2',
      'row:c1',
      'row:t3',
      'group:a1',
      'group:c2',
      'row:t4',
      'row:t5',
      'row:t6',
      'row:ghost',
    ]);
  });

  it('words a group like the mockup: letter, turns, "summarised", the summary as sub line, a chevron', () => {
    const items = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: '' }).items;
    const a = items.find((i) => i.key === 'group:a1');
    expect(a).toMatchObject({
      title: 'Branch A, 2 turns, summarised',
      summary: 'Generator typing fixed, then abandoned',
      chevron: '▸',
      side: true,
      selectId: undefined,
    });
    expect(items.find((i) => i.key === 'group:c2')).toMatchObject({ title: 'Branch C, 1 turn', chevron: '▸' });
    expect(a?.node).toMatchObject({ kind: 'group', dashed: true, lane: 1 });
  });

  it('draws the curve from the fork row into each group lane and lets a lane run past the groups in between', () => {
    const items = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: '' }).items;
    const at = (key: string) => items.find((i) => i.key === key)?.node;
    expect(at('row:t3')).toMatchObject({ forks: [1, 2], up: true, down: true });
    // lane 2 starts at the fork row and passes the lane 1 group on the way to its own group
    expect(at('group:a1')).toMatchObject({ through: [0, 2], up: true, down: false });
    expect(at('group:c2')).toMatchObject({ through: [0], up: true, down: false });
    expect(at('row:t4')).toMatchObject({ through: [], lane: 0 });
    expect(layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: '' }).lanes).toBe(3);
  });

  it('keeps the active path one unbroken line from the root to the ghost', () => {
    const items = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: '' }).items;
    const active = items.filter((i) => i.node.lane === 0 && i.type !== 'group');
    expect(active[0].node).toMatchObject({ up: false, down: true });
    expect(active.slice(1, -1).every((i) => i.node.up && i.node.down)).toBe(true);
    expect(active.at(-1)?.node).toMatchObject({ kind: 'ghost', up: true, down: false });
  });

  it('puts a compaction in a 28px band and every other row at 36px', () => {
    const items = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: '' }).items;
    expect(items.find((i) => i.key === 'row:c1')).toMatchObject({
      type: 'band',
      height: 28,
      title: 'Compacted, 51k tokens summarised',
    });
    expect(items.filter((i) => i.type !== 'band').every((i) => i.height === 36)).toBe(true);
  });

  it('gives the leaf "current" instead of a time, and the ring figure as the tooltip', () => {
    const leaf = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: '' }).items.find(
      (i) => i.key === 'row:t6',
    );
    expect(leaf).toMatchObject({ time: 'current', current: true, timeTitle: '88 % of context, 231k of 262k' });
    expect(leaf?.node.contextPct).toBe(88);
  });
});

describe('layoutGraph, expanded and unfolded', () => {
  it('an unfolded group keeps its group row and adds its turns, tinted, in the same lane run', () => {
    const items = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(['a1']), query: '' }).items;
    expect(items.map((i) => i.key).slice(4, 10)).toEqual([
      'row:t3',
      'group:a1',
      'row:a1',
      'row:a2',
      'group:c2',
      'row:t4',
    ]);
    const [group, first, second] = items.slice(5, 8);
    expect(group).toMatchObject({ chevron: '▾' });
    expect(group.node).toMatchObject({ up: true, down: true });
    expect(first).toMatchObject({ side: true, selectId: 'a1' });
    expect(first.node).toMatchObject({ up: true, down: true, lane: 1 });
    expect(second.node).toMatchObject({ up: true, down: false });
    // the active path crosses these rows, and lane 2 now passes three rows on its way to its own group
    expect(first.node.through).toEqual([0, 2]);
    expect(second.node.through).toEqual([0, 2]);
  });

  it('with folding off there are no group rows and every turn shows', () => {
    const items = layoutGraph(english, treeOf(demo()), { fold: false, expanded: new Set(), query: '' }).items;
    expect(items.some((i) => i.key.startsWith('group:'))).toBe(false);
    expect(items.filter((i) => i.side).map((i) => i.row.id)).toEqual(['a1', 'a2', 'c2']);
    // the lane-2 branch is a line from the fork row down to its row, past the lane 1 turns
    expect(items.find((i) => i.row.id === 'a1')?.node.through).toEqual([0, 2]);
  });
});

describe('layoutGraph, "Find a turn"', () => {
  it('shows only the matching rows, with the lines of what is left and the match marked', () => {
    const layout = layoutGraph(english, treeOf(demo()), { fold: true, expanded: new Set(), query: 'observable' });
    expect(layout.items.map((i) => i.key)).toEqual(['row:t4']);
    expect(layout.items[0]).toMatchObject({
      match: true,
      titleParts: [
        { text: 'Use an ', hit: false },
        { text: 'Observable', hit: true },
        { text: ' instead', hit: false },
      ],
    });
    expect(layout.items[0].node).toMatchObject({ up: false, down: false, through: [], forks: [] });
    expect(layout.lanes).toBe(1);
    expect(layout.hidden).toBe(demo().length - 1);
  });

  it('searches side branches too, whatever the folding, and the tools a turn used', () => {
    expect(keys(demo(), { query: 'generator' })).toEqual(['row:t3', 'row:a1']);
    expect(keys(demo(), { query: 'map.ts' })).toEqual(['row:t1']);
    expect(keys(demo(), { query: '   ' })).toHaveLength(11);
  });

  it('a lane shown without the row it forked from has no curve into it', () => {
    const items = layoutGraph(english, treeOf(demo()), {
      fold: true,
      expanded: new Set(),
      query: 'run the specs',
    }).items;
    expect(items.map((i) => i.key)).toEqual(['row:a2']);
    expect(items[0].node).toMatchObject({ up: false, down: false });
  });

  it('matches title, label, number, model and tool names; never the ghost', () => {
    const turn = row({
      id: 'x',
      preview: 'Use an Observable',
      label: 'good-path',
      number: '4',
      model: 'opus',
      sub: [{ name: 'bash', target: 'vitest' }],
    });
    for (const q of ['observable', 'GOOD', '4', 'opus', 'vitest', 'bash']) expect(rowMatches(turn, q)).toBe(true);
    expect(rowMatches(turn, 'nothing')).toBe(false);
    expect(rowMatches(row({ id: 'g', kind: 'ghost', preview: 'Next turn goes here' }), 'next')).toBe(false);
  });
});

describe('row words', () => {
  it('the sub line tail names the model only when it changed, then the tokens', () => {
    expect(subTail(english, row({ id: 'a', tokens: 6100 }))).toBe('6.1k');
    expect(
      subTail(english, row({ id: 'a', tokens: 6100, modelChanged: true, model: 'sonnet', thinking: 'high' })),
    ).toBe('sonnet at high, 6.1k');
    expect(subTail(english, row({ id: 'a', tokens: 0 }))).toBe('');
    expect(modelLine(english, { model: 'gemma', thinking: 'off' })).toBe('gemma');
  });
  it('shows the context figure only when all three numbers are there', () => {
    expect(contextTitle(english, { contextPct: 24, contextTokens: 62_000, contextWindow: 262_144 })).toBe(
      '24 % of context, 62k of 262k',
    );
    expect(contextTitle(english, { contextPct: 24 })).toBeUndefined();
  });
  it('formats the time in 24 hours and tolerates a missing one', () => {
    expect(formatClock(new Date(2026, 9, 15, 12, 41).toISOString())).toBe('12:41');
    expect(formatClock(new Date(2026, 9, 15, 3, 5).toISOString())).toBe('03:05');
    expect(formatClock(undefined)).toBe('');
    expect(formatClock('nonsense')).toBe('');
  });
  it('splits a title at every match, ignoring case', () => {
    expect(highlight('Fix fix FIX', 'fix').map((p) => p.hit)).toEqual([true, false, true, false, true]);
    expect(highlight('abc', '')).toEqual([{ text: 'abc', hit: false }]);
  });
  it('says where the leaf is in the session', () => {
    expect(positionLine(english, treeOf(demo(), { turns: 11, leafRowId: 't6' }))).toBe('Turn 6 of 11');
    expect(
      positionLine(
        english,
        treeOf([row({ id: 'root', kind: 'root', turn: null, isLeaf: true })], { leafRowId: 'root' }),
      ),
    ).toBe('At the start');
  });
});

describe('selection', () => {
  const items = [
    { selectId: 'root' },
    { selectId: undefined },
    { selectId: 'a' },
    { selectId: 'b' },
    { selectId: undefined },
  ];
  it('skips group rows and the ghost', () => {
    expect(stepSelection(items, 0, 1)).toBe(2);
    expect(stepSelection(items, 3, 1)).toBe(3);
    expect(stepSelection(items, 2, -1)).toBe(0);
    expect(edgeSelection(items, -1)).toBe(3);
    expect(edgeSelection(items, 1)).toBe(0);
  });
});
