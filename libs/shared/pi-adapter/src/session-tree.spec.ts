import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PiSessionEntry } from './session-messages';
import { branchLetter, buildSessionTree, shellProgram, shortCount } from './session-tree';

let clock = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 15, 12, 0, clock++)).toISOString();

const system = (id: string, parentId: string | null): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: stamp(),
  message: { role: 'system', content: '' },
});
const user = (id: string, parentId: string | null, text: string): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: stamp(),
  message: { role: 'user', content: text },
});
const assistant = (id: string, parentId: string, tokens = 100): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: stamp(),
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'm1',
    thinkingLevel: 'high',
    usage: { input: tokens - 10, output: 10, cacheRead: 5000, cacheWrite: 0 },
  },
});
const toolResult = (id: string, parentId: string): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: stamp(),
  message: { role: 'toolResult', content: [{ type: 'text', text: 'x' }] },
});
const compaction = (id: string, parentId: string, tokensBefore = 51_000): PiSessionEntry => ({
  type: 'compaction',
  id,
  parentId,
  timestamp: stamp(),
  summary: 's',
  firstKeptEntryId: parentId,
  tokensBefore,
});
const label = (id: string, parentId: string, targetId: string, text?: string): PiSessionEntry => ({
  type: 'label',
  id,
  parentId,
  timestamp: stamp(),
  targetId,
  label: text,
});
const modelChange = (id: string, parentId: string): PiSessionEntry => ({ type: 'model_change', id, parentId, timestamp: stamp(), provider: 'p', modelId: 'm2' });
const branchSummary = (id: string, parentId: string, fromId: string): PiSessionEntry => ({
  type: 'branch_summary',
  id,
  parentId,
  timestamp: stamp(),
  fromId,
  summary: '## Goal\nTried the generator.',
});

describe('buildSessionTree: collapsing', () => {
  it('folds everything up to the next user message into one row', () => {
    const tree = buildSessionTree(
      [
        system('s', null),
        user('u1', 's', 'first question'),
        assistant('a1', 'u1', 200),
        toolResult('t1', 'a1'),
        assistant('a2', 't1', 300),
        user('u2', 'a2', 'second question'),
        assistant('a3', 'u2', 50),
      ],
      'a3',
    );
    expect(tree.rows.map((r) => [r.kind, r.id, r.number, r.entryCount])).toEqual([
      ['root', 'root', '', 1],
      ['turn', 'u1', '1', 4],
      ['turn', 'u2', '2', 2],
      ['ghost', 'ghost', '', 0],
    ]);
    const turn1 = tree.rows[1];
    expect(turn1.preview).toBe('first question');
    expect(turn1.endId).toBe('a2');
    expect(turn1.tokens).toBe(200 + 300);
    expect(turn1.model).toBe('m1');
    expect(turn1.thinking).toBe('high');
    expect(tree.rows[0].preview).toBe('Start, system prompt');
    expect(tree.turns).toBe(2);
    expect(tree.forks).toBe(0);
  });

  it('treats labels, model changes and other bookkeeping entries as transparent', () => {
    const tree = buildSessionTree(
      [
        user('u1', null, 'one'),
        assistant('a1', 'u1'),
        modelChange('m', 'a1'),
        label('l', 'm', 'u1', 'good-path'),
        user('u2', 'l', 'two'),
        assistant('a2', 'u2'),
      ],
      'a2',
    );
    expect(tree.rows.map((r) => r.id)).toEqual(['root', 'u1', 'u2', 'ghost']);
    expect(tree.rows[0].preview).toBe('Start');
    expect(tree.rows[1].label).toBe('good-path');
    expect(tree.rows[1].entryCount).toBe(2);
    expect(tree.rows[2].parentId).toBe('u1');
  });

  it('lets the latest label win and an empty one clear it', () => {
    const base = [user('u1', null, 'one'), assistant('a1', 'u1')];
    const set = buildSessionTree([...base, label('l1', 'a1', 'u1', 'x'), label('l2', 'l1', 'u1', 'y')], 'l2');
    expect(set.rows[1].label).toBe('y');
    const cleared = buildSessionTree([...base, label('l1', 'a1', 'u1', 'x'), label('l2', 'l1', 'u1', undefined)], 'l2');
    expect(cleared.rows[1].label).toBeUndefined();
  });

  it('truncates the preview to 80 characters and collapses whitespace', () => {
    const long = `line one\n\n${'word '.repeat(40)}`;
    const row = buildSessionTree([user('u1', null, long)], 'u1').rows[1];
    expect(row.preview.startsWith('line one word word')).toBe(true);
    expect(row.preview.length).toBe(81);
    expect(row.preview.endsWith('…')).toBe(true);
  });

  it('draws compactions and branch summaries as their own rows', () => {
    const tree = buildSessionTree(
      [
        user('u1', null, 'one'),
        assistant('a1', 'u1'),
        compaction('c', 'a1'),
        user('u2', 'c', 'two'),
        assistant('a2', 'u2'),
        branchSummary('b', 'a2', 'zz'),
        user('u3', 'b', 'three'),
      ],
      'u3',
    );
    expect(tree.rows.map((r) => [r.kind, r.number])).toEqual([
      ['root', ''],
      ['turn', '1'],
      ['compaction', ''],
      ['turn', '2'],
      ['branch_summary', ''],
      ['turn', '3'],
      ['ghost', ''],
    ]);
    expect(tree.rows[2].preview).toBe('Compacted, 51k tokens summarised');
    expect(tree.rows[4].preview).toBe('Summary, Tried the generator.');
  });

  it('puts an empty session on the root and the ghost row', () => {
    const tree = buildSessionTree([], null);
    expect(tree.rows.map((r) => r.kind)).toEqual(['root', 'ghost']);
    expect(tree.rows[0]).toMatchObject({ isLeaf: true, up: false, down: true, lane: 0 });
    expect(tree.rows[1]).toMatchObject({ up: true, down: false, lane: 0, parentId: 'root' });
    expect(tree.lanes).toBe(2);
  });
});

describe('buildSessionTree: lanes', () => {
  /** s - u1 - a1 - u2 - a2 (fork at a1) - u3 - a3 ; and u2b under a1 (abandoned, with a child u2c). */
  const forked = [
    system('s', null),
    user('u1', 's', 'one'),
    assistant('a1', 'u1'),
    user('u2', 'a1', 'two'),
    assistant('a2', 'u2'),
    user('u3', 'a2', 'three'),
    assistant('a3', 'u3'),
    user('u2b', 'a1', 'two, again'),
    assistant('a2b', 'u2b'),
    user('u2c', 'a2b', 'two, once more'),
  ];

  it('keeps the active path in lane 0 and sends the abandoned branch to lane 1, before the continuing branch', () => {
    const tree = buildSessionTree(forked, 'a3');
    expect(tree.rows.map((r) => [r.id, r.lane])).toEqual([
      ['root', 0],
      ['u1', 0],
      ['u2b', 1],
      ['u2c', 1],
      ['u2', 0],
      ['u3', 0],
      ['ghost', 0],
    ]);
    expect(tree.forks).toBe(1);
    expect(tree.lanes).toBe(2);
    const fork = tree.rows[1];
    expect(fork).toMatchObject({ forks: [1], childCount: 2, up: true, down: true, through: [] });
    // The side branch's line is open from the fork row down to its first row.
    expect(tree.rows[2]).toMatchObject({ lane: 1, parentLane: 0, up: true, down: true, through: [0], onActivePath: false });
    expect(tree.rows[3]).toMatchObject({ lane: 1, up: true, down: false, through: [0] });
    // The branch ended, so lane 1 is free again for the rows after it.
    expect(tree.rows[4]).toMatchObject({ lane: 0, through: [], parentLane: 0, onActivePath: true });
  });

  it('numbers the active path 1, 2, 3 and the side branch with its letter', () => {
    const tree = buildSessionTree(forked, 'a3');
    expect(tree.rows.filter((r) => r.kind === 'turn').map((r) => [r.id, r.number, r.turn])).toEqual([
      ['u1', '1', 1],
      ['u2b', '2a', 2],
      ['u2c', '3a', 3],
      ['u2', '2', 2],
      ['u3', '3', 3],
    ]);
  });

  it('puts the leaf row on the abandoned branch in lane 0 when that is the active path, and the old path aside', () => {
    const tree = buildSessionTree(forked, 'u2c');
    expect(tree.rows.map((r) => [r.id, r.lane, r.isLeaf])).toEqual([
      ['root', 0, false],
      ['u1', 0, false],
      ['u2', 1, false],
      ['u3', 1, false],
      ['u2b', 0, false],
      ['u2c', 0, true],
      ['ghost', 0, false],
    ]);
    expect(tree.rows.find((r) => r.id === 'u3')?.onActivePath).toBe(false);
    expect(tree.leafRowId).toBe('u2c');
  });

  it('places the ghost row right under a leaf in the middle of the tree and opens lanes for what lies below it', () => {
    const tree = buildSessionTree(forked, 'a2');
    expect(tree.rows.map((r) => [r.id, r.lane])).toEqual([
      ['root', 0],
      ['u1', 0],
      ['u2b', 1],
      ['u2c', 1],
      ['u2', 0],
      ['ghost', 0],
      ['u3', 1],
    ]);
    const leaf = tree.rows.find((r) => r.id === 'u2');
    expect(leaf).toMatchObject({ isLeaf: true, forks: [1], down: true, childCount: 1 });
    // The ghost row is crossed by the lane that leads to the abandoned child; lane 0 stops at the ghost.
    expect(tree.rows[5]).toMatchObject({ through: [1], up: true, down: false });
    expect(tree.rows[6]).toMatchObject({ lane: 1, through: [], up: true, down: false });
  });

  it('gives sibling branches their own lanes, nested forks the next free one, and frees them as branches end', () => {
    const entries = [
      user('u1', null, 'root turn'),
      assistant('a1', 'u1'),
      user('x', 'a1', 'x'),
      user('y', 'a1', 'y'),
      user('z', 'a1', 'z'),
      assistant('az', 'z'),
      // y forks again
      assistant('ay', 'y'),
      user('y1', 'ay', 'y1'),
      user('y2', 'ay', 'y2'),
      // the active path goes through the newest child of a1 (z)
    ];
    const tree = buildSessionTree(entries, 'az');
    expect(tree.rows.map((r) => [r.id, r.lane, r.through, r.forks])).toEqual([
      ['root', 0, [], []],
      ['u1', 0, [], [1, 2]],
      ['x', 1, [0, 2], []],
      ['y', 2, [0], [3]],
      ['y1', 3, [0, 2], []],
      ['y2', 2, [0], []],
      ['z', 0, [], []],
      ['ghost', 0, [], []],
    ]);
    expect(tree.lanes).toBe(4);
    expect(tree.forks).toBe(3);
    // Letters follow the order the branches are met in; the nested fork continues the alphabet.
    expect(tree.rows.filter((r) => r.kind === 'turn').map((r) => r.number)).toEqual(['1', '2a', '2b', '3c', '3b', '2']);
  });

  it('treats several roots as children of the synthetic root row', () => {
    // A user message that became a second root (edit and branch on the first message of a session without a system prompt).
    const tree = buildSessionTree([user('u1', null, 'old'), assistant('a1', 'u1'), user('u1b', null, 'new'), assistant('a1b', 'u1b')], 'a1b');
    expect(tree.rows.map((r) => [r.id, r.lane, r.parentId])).toEqual([
      ['root', 0, null],
      ['u1', 1, 'root'],
      ['u1b', 0, 'root'],
      ['ghost', 0, 'u1b'],
    ]);
  });

  it('lets entries whose parent is unknown start their own branch', () => {
    const tree = buildSessionTree([user('u1', null, 'one'), user('orphan', 'gone', 'lost')], 'u1');
    expect(tree.rows.map((r) => r.id)).toEqual(['root', 'orphan', 'u1', 'ghost']);
  });

  it('uses the nearest node when the leaf is a transparent entry', () => {
    const tree = buildSessionTree([user('u1', null, 'one'), assistant('a1', 'u1'), label('l', 'a1', 'u1', 'x')], 'l');
    expect(tree.leafRowId).toBe('u1');
    expect(tree.rows.at(-1)).toMatchObject({ kind: 'ghost', parentId: 'u1' });
  });

  it('shows a sibling created by prompting from an earlier node as a second child of that row', () => {
    const before = [user('u1', null, 'one'), assistant('a1', 'u1'), user('u2', 'a1', 'two'), assistant('a2', 'u2')];
    const after = [...before, user('u2n', 'a1', 'two, edited'), assistant('a2n', 'u2n')];
    const tree = buildSessionTree(after, 'a2n');
    expect(tree.rows.find((r) => r.id === 'u1')?.childCount).toBe(2);
    expect(tree.rows.filter((r) => r.onActivePath).map((r) => r.id)).toEqual(['root', 'u1', 'u2n', 'ghost']);
  });

  it('keeps edited user messages as siblings when the system prompt changes on the new branch', () => {
    const entries = [
      system('s', null),
      user('u1', 's', 'original request'),
      assistant('a1', 'u1'),
      { ...system('s2', 's'), message: { role: 'system', content: '', sections: { other_agents: 'Another chat is active.' } } },
      user('u1b', 's2', 'edited request'),
      assistant('a1b', 'u1b'),
    ];
    const tree = buildSessionTree(entries, 'a1b');
    expect(tree.rows.filter((row) => row.kind === 'turn').map((row) => [row.id, row.parentId])).toEqual([
      ['u1', 'root'], ['u1b', 'root'],
    ]);
    expect(tree.rows[0].childCount).toBe(2);
    expect(tree.rows.find((row) => row.id === 'u1b')?.onActivePath).toBe(true);
  });

  it('copes with a long chain without recursion', () => {
    const entries: PiSessionEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 4000; i++) {
      entries.push(user(`u${i}`, parent, `turn ${i}`));
      entries.push(assistant(`a${i}`, `u${i}`));
      parent = `a${i}`;
    }
    const tree = buildSessionTree(entries, parent);
    expect(tree.rows).toHaveLength(4002);
    expect(tree.rows.every((r) => r.lane === 0)).toBe(true);
  });
});

describe('buildSessionTree: graph v2 facts', () => {
  const call = (id: string, parentId: string, calls: { name: string; arguments: Record<string, unknown> }[], model = 'm1', usage = { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 }): PiSessionEntry => ({
    type: 'message',
    id,
    parentId,
    timestamp: stamp(),
    message: { role: 'assistant', model, provider: 'p', thinkingLevel: 'high', usage, content: calls.map((c, i) => ({ type: 'toolCall', id: `${id}-${i}`, name: c.name, arguments: c.arguments })) },
  });

  it('lists a turn\'s tool calls with the file or program each was about, repeats folded', () => {
    const tree = buildSessionTree(
      [
        user('u1', null, 'go'),
        call('a1', 'u1', [
          { name: 'read', arguments: { path: 'src/map.ts' } },
          { name: 'edit', arguments: { path: '/work/src/map.ts' } },
          { name: 'edit', arguments: { path: 'src/map.ts' } },
          { name: 'bash', arguments: { command: 'cd app && npx vitest run --reporter=dot' } },
          { name: 'bash', arguments: { command: 'npm test' } },
          { name: 'grep', arguments: { pattern: 'TODO' } },
          { name: 'mcp__issues__open', arguments: {} },
        ]),
      ],
      'a1',
    );
    expect(tree.rows[1].sub).toEqual([
      { name: 'read', target: 'map.ts' },
      { name: 'edit', target: 'map.ts' },
      { name: 'bash', target: 'vitest' },
      { name: 'bash', target: 'npm test' },
      { name: 'grep', target: 'TODO' },
      { name: 'mcp__issues__open' },
    ]);
    expect(tree.rows[0].sub).toEqual([]);
    expect(tree.rows.at(-1)?.sub).toEqual([]);
  });

  it('caps the sub line at eight calls', () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({ name: 'read', arguments: { path: `f${i}.ts` } }));
    expect(buildSessionTree([user('u1', null, 'go'), call('a1', 'u1', calls)], 'a1').rows[1].sub).toHaveLength(8);
  });

  it('knows what program a shell command runs', () => {
    expect(shellProgram('FOO=1 npx vitest run')).toBe('vitest');
    expect(shellProgram('cd x && git status')).toBe('git status');
    expect(shellProgram('ls -la | head')).toBe('ls');
    expect(shellProgram('')).toBeUndefined();
  });

  it('gives a turn the time its last entry was written, and marks a model change against the turn before', () => {
    const tree = buildSessionTree(
      [
        user('u1', null, 'one'),
        call('a1', 'u1', [], 'm1'),
        user('u2', 'a1', 'two'),
        call('a2', 'u2', [], 'm1'),
        user('u3', 'a2', 'three'),
        call('a3', 'u3', [], 'm2'),
      ],
      'a3',
    );
    const [, one, two, three] = tree.rows;
    expect(one.time).toBe(Date.parse(one.timestamp as string) < Date.parse(one.time as string) ? one.time : undefined);
    expect(one.time).not.toBe(one.timestamp);
    expect([one, two, three].map((r) => r.modelChanged)).toEqual([false, false, true]);
  });

  it('assigns lane runs and abandoned-branch groups: the first row of a side branch names the group and its letter', () => {
    const entries = [
      system('s', null),
      user('u1', 's', 'one'),
      assistant('a1', 'u1'),
      user('u2', 'a1', 'two'),
      assistant('a2', 'u2'),
      user('u3', 'a2', 'three'),
      assistant('a3', 'u3'),
      user('b1', 'a1', 'two, again'),
      assistant('b1a', 'b1'),
      user('b2', 'b1a', 'two, once more'),
      assistant('b2a', 'b2'),
      user('c1', 'b1a', 'a nested fork'),
      assistant('c1a', 'c1'),
    ];
    const tree = buildSessionTree(entries, 'a3');
    const at = (id: string) => tree.rows.find((r) => r.id === id) as (typeof tree.rows)[number];
    // the active path and the ghost are one run
    expect(['root', 'u1', 'u2', 'u3', 'ghost'].map((id) => at(id).run)).toEqual(Array(5).fill('root'));
    expect(['root', 'u1', 'u2', 'u3', 'ghost'].some((id) => at(id).group !== undefined)).toBe(false);
    // the side branch: its own run and one group; at its own fork the newest child carries on in the same lane and run, the other takes a lane of its own, inside the same group
    expect(at('b1')).toMatchObject({ run: 'b1', group: 'b1', groupLetter: 'A', lane: 1 });
    expect(at('c1')).toMatchObject({ run: 'b1', group: 'b1', groupLetter: 'A', lane: 1 });
    expect(at('b2')).toMatchObject({ run: 'b2', group: 'b1', groupLetter: 'A', lane: 2 });
  });

  it('gives the first row of a group the branch summary written for it (named by fromId)', () => {
    const entries = [
      user('u1', null, 'one'),
      assistant('a1', 'u1'),
      user('x1', 'a1', 'the abandoned way'),
      assistant('x1a', 'x1'),
      user('x2', 'x1a', 'more of it'),
      assistant('x2a', 'x2'),
      // the user went back to a1, asking pi to summarise the branch they left (its leaf was x2a)
      branchSummary('bs', 'a1', 'x2a'),
      user('u2', 'bs', 'the new way'),
      assistant('a2', 'u2'),
    ];
    const tree = buildSessionTree(entries, 'a2');
    const head = tree.rows.find((r) => r.id === 'x1');
    expect(head).toMatchObject({ group: 'x1', summary: 'Tried the generator.' });
    expect(tree.rows.find((r) => r.id === 'x2')?.summary).toBeUndefined();
    // the summary row itself is on the active path and is no group
    expect(tree.rows.find((r) => r.id === 'bs')?.kind).toBe('branch_summary');
    expect(tree.rows.find((r) => r.id === 'bs')?.group).toBeUndefined();
  });

  it('shows what the leaf\'s later turns are as a group of their own', () => {
    const entries = [user('u1', null, 'one'), assistant('a1', 'u1'), user('u2', 'a1', 'two'), assistant('a2', 'u2'), user('u3', 'a2', 'three')];
    const tree = buildSessionTree(entries, 'a1');
    expect(tree.rows.map((r) => [r.id, r.group ?? null])).toEqual([['root', null], ['u1', null], ['ghost', null], ['u2', 'u2'], ['u3', 'u2']]);
  });

  describe('context ring', () => {
    const windows = (_provider: string | undefined, model: string) => (model === 'm1' ? 1000 : undefined);
    it('is the share of the model window the last answer of the turn used, with its figures for the tooltip', () => {
      const tree = buildSessionTree(
        [
          user('u1', null, 'one'),
          call('a1', 'u1', [], 'm1', { input: 200, output: 50, cacheRead: 600, cacheWrite: 0 }),
          user('u2', 'a1', 'two'),
          call('a2', 'u2', [], 'm1', { input: 20, output: 10, cacheRead: 40, cacheWrite: 0 }),
        ],
        'a2',
        { contextWindow: windows },
      );
      expect(tree.rows[1]).toMatchObject({ contextTokens: 850, contextWindow: 1000, contextPct: 85 });
      // after a compaction the next turn starts from a short context again: the arc drops
      expect(tree.rows[2]).toMatchObject({ contextTokens: 70, contextPct: 7 });
    });
    it('uses the message\'s own total when it has one, caps at 100 and leaves the ring off for an unknown window', () => {
      const withTotal = call('a1', 'u1', [], 'm1', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
      (withTotal['message'] as { usage: Record<string, number> }).usage['totalTokens'] = 1500;
      expect(buildSessionTree([user('u1', null, 'one'), withTotal], 'a1', { contextWindow: windows }).rows[1].contextPct).toBe(100);
      const unknown = buildSessionTree([user('u1', null, 'one'), call('a1', 'u1', [], 'other')], 'a1', { contextWindow: windows });
      expect(unknown.rows[1].contextPct).toBeUndefined();
      expect(buildSessionTree([user('u1', null, 'one'), call('a1', 'u1', [])], 'a1').rows[1].contextPct).toBeUndefined();
    });
    it('is only drawn for turns', () => {
      const tree = buildSessionTree([user('u1', null, 'one'), call('a1', 'u1', [], 'm1'), compaction('c', 'a1')], 'c', { contextWindow: windows });
      expect(tree.rows.find((r) => r.kind === 'compaction')?.contextPct).toBeUndefined();
      expect(tree.rows[0].contextPct).toBeUndefined();
    });
  });
});

describe('helpers', () => {
  it('names branches a..z, aa..', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(branchLetter)).toEqual(['a', 'b', 'z', 'aa', 'ab', 'az', 'ba']);
  });
  it('abbreviates token counts', () => {
    expect([999, 1000, 1500, 9999, 10_000, 51_234].map(shortCount)).toEqual(['999', '1k', '1.5k', '10k', '10k', '51k']);
  });
});

describe('buildSessionTree on the recorded session', () => {
  it('collapses the fixture session into turns', () => {
    const recorded = readFileSync(join(__dirname, '..', 'fixtures', 'session.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as PiSessionEntry)
      .filter((entry) => entry.type !== 'session');
    const leaf = recorded.at(-1)?.id ?? null;
    const tree = buildSessionTree(recorded, leaf);
    expect(tree.rows.filter((r) => r.kind === 'turn')).toHaveLength(2);
    expect(tree.forks).toBe(0);
    expect(tree.rows.at(-1)?.kind).toBe('ghost');
  });
});
