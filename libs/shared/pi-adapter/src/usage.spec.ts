import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PiSessionEntry } from './session-messages';
import { aggregateUsage } from './usage';

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: cost } });
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();
const meta = { sessionId: 's1', sessionFile: '/tmp/s1.jsonl' };

const user = (id: string, parentId: string | null, text: string, t: number): PiSessionEntry => ({ type: 'message', id, parentId, timestamp: at(t), message: { role: 'user', content: text } });
const reply = (id: string, parentId: string, t: number, u: ReturnType<typeof usage>, model = 'gemma'): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  timestamp: at(t),
  message: { role: 'assistant', provider: 'llama-swap', model, usage: u, content: [] },
});

describe('aggregateUsage', () => {
  const entries: PiSessionEntry[] = [
    user('u1', null, 'first question', 0),
    reply('a1', 'u1', 4, usage(100, 20, 0, 50, 0.01)),
    user('u2', 'a1', 'second\nquestion', 10),
    reply('a2', 'u2', 12, usage(200, 30, 500, 0, 0.02)),
    reply('a3', 'a2', 15, usage(250, 40, 500, 0, 0.03), 'llama3.2'),
    { type: 'usage', id: 'w1', parentId: 'a3', timestamp: at(20), kind: 'cache_warm', provider: 'llama-swap', model: 'gemma', usage: usage(0, 0, 700, 0, 0.005) },
    { type: 'compaction', id: 'c1', parentId: 'w1', timestamp: at(30), summary: 's', firstKeptEntryId: 'u2', tokensBefore: 9000, usage: usage(300, 60, 0, 0, 0.04) },
    user('u3', 'c1', 'third', 40),
    reply('a4', 'u3', 42, usage(400, 10, 0, 0, 0.05)),
    { type: 'model_change', id: 'm1', parentId: 'a4', timestamp: at(50), provider: 'x', modelId: 'y' },
  ];
  const result = aggregateUsage(entries, meta);

  it('totals every usage-bearing entry the way pi does (assistant messages, usage entries, compaction summaries)', () => {
    expect(result.totals).toMatchObject({ input: 1250, output: 160, cacheRead: 1700, cacheWrite: 50, total: 3160, requests: 6, turns: 3 });
    expect(result.totals.cost).toBeCloseTo(0.155, 10);
  });

  it('has per-turn rows and per-model rows that add up to the totals', () => {
    for (const rows of [result.byTurn, result.byModel]) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'requests'] as const) {
        expect(rows.reduce((n, r) => n + r[key], 0)).toBe(result.totals[key]);
      }
      expect(rows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(result.totals.cost, 10);
    }
  });

  it('attributes requests to the nearest user message above them, with a preview and the models that answered', () => {
    expect(result.byTurn.map((t) => t.turn)).toEqual([1, 2, 3]);
    expect(result.byTurn[1]).toMatchObject({ preview: 'second question', models: ['llama-swap/gemma', 'llama-swap/llama3.2', 'compaction summary'], input: 750, requests: 4 });
    // the compaction summary and the cache warming hang below turn 2
    expect(result.byTurn[1].cacheRead).toBe(500 + 500 + 700);
    expect(result.byTurn[2].preview).toBe('third');
  });

  it('measures a turn by the time between each request and the entry it answers', () => {
    expect(result.byTurn[0].elapsedMs).toBe(4000);
    expect(result.byTurn[1].elapsedMs).toBe(2000 + 3000);
  });

  it('computes the cache hit ratio and lists compactions with the context the next response saw', () => {
    expect(result.cacheHitRatio).toBeCloseTo(1700 / (1250 + 1700 + 50), 10);
    expect(result.compactions).toEqual([{ entryId: 'c1', timestamp: at(30), tokensBefore: 9000, tokensAfter: 400 }]);
  });

  it('counts a branch it left too (pi sums every entry of the file) and gives usage before any message a row of its own', () => {
    const forked = aggregateUsage([...entries, reply('b1', 'u1', 60, usage(7, 1)), { type: 'usage', id: 'w0', parentId: null, usage: usage(5, 0) }], meta);
    expect(forked.totals.input).toBe(1250 + 7 + 5);
    expect(forked.byTurn.find((t) => t.turn === 1)?.input).toBe(100 + 7);
    expect(forked.byTurn[0]).toMatchObject({ turn: 0, preview: 'Before the first message', input: 5 });
  });

  it('is zero for an empty file', () => {
    expect(aggregateUsage([], meta).totals).toMatchObject({ total: 0, cost: 0, requests: 0, turns: 0 });
    expect(aggregateUsage([], meta).cacheHitRatio).toBeNull();
  });

  it('matches the totals pi computes for the recorded session file', () => {
    const recorded = readFileSync(join(__dirname, '..', 'fixtures', 'session.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as PiSessionEntry)
      .filter((e) => e.type !== 'session');
    // pi's `getSessionStats()`: the sum over every assistant message's usage.
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cost = 0;
    for (const e of recorded) {
      const m = e['message'] as { role?: string; usage?: { input: number; output: number; cacheRead: number; cost?: { total: number } } } | undefined;
      if (m?.role === 'assistant' && m.usage) {
        input += m.usage.input;
        output += m.usage.output;
        cacheRead += m.usage.cacheRead;
        cost += m.usage.cost?.total ?? 0;
      }
    }
    const result = aggregateUsage(recorded, meta);
    expect(result.totals).toMatchObject({ input, output, cacheRead });
    expect(result.totals.cost).toBeCloseTo(cost, 10);
    expect(result.totals.turns).toBe(recorded.filter((e) => (e['message'] as { role?: string } | undefined)?.role === 'user').length);
  });
});
