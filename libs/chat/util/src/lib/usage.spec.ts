import { english } from '@pi-kit/i18n/testing';
import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { modelDetail, priceLabel } from '@pi-kit/ui';
import { buildTranscript } from './transcript-model';
import { contextLevel, contextPercent, formatSeconds, percentLabel, totalsLine, usageLine } from './usage';

describe('context meter', () => {
  it('steps at 70 and 90 percent', () => {
    expect(contextLevel(0)).toBe('ok');
    expect(contextLevel(69.9)).toBe('ok');
    expect(contextLevel(70)).toBe('warning');
    expect(contextLevel(89.9)).toBe('warning');
    expect(contextLevel(90)).toBe('error');
    expect(contextLevel(100)).toBe('error');
  });
  it('computes and labels the percentage', () => {
    expect(contextPercent(48_000, 262_144)).toBeCloseTo(18.31, 1);
    expect(contextPercent(1, 0)).toBe(0);
    expect(percentLabel(18.31)).toBe('18%');
    expect(percentLabel(1.1)).toBe('1.1%');
    expect(percentLabel(0)).toBe('0%');
  });
});

describe('usage line and totals', () => {
  const usage = {
    requests: 2,
    input: 3100,
    output: 420,
    cacheRead: 48_000,
    cacheWrite: 0,
    cost: 0.012,
    elapsedMs: 4200,
    models: ['anthropic/claude-sonnet-5-5'],
  };
  it('reads like the mockup: in, out, cache read, cost, time, model', () => {
    expect(usageLine(english, usage)).toBe('in 3.1k · out 420 · cache read 48k · $0.0120 · 4.2s · claude-sonnet-5-5');
  });
  it('leaves out what is zero', () => {
    expect(usageLine(english, { ...usage, cacheRead: 0, cost: 0, elapsedMs: 0, models: [] })).toBe('in 3.1k · out 420');
  });
  it('formats seconds and the status bar totals', () => {
    expect(formatSeconds(800)).toBe('0.8s');
    expect(formatSeconds(12_400)).toBe('12s');
    expect(formatSeconds(72_000)).toBe('1m 12s');
    expect(totalsLine(english, 0.84, 112_000, 9)).toBe('$0.84 · 112k tokens · 9 turns');
    expect(totalsLine(english, 0, 10, 1)).toBe('$0.00 · 10 tokens · 1 turn');
  });
});

describe('model rows', () => {
  it('shows window and price per million, or free', () => {
    expect(priceLabel(english, { costInput: 3, costOutput: 15 })).toBe('$3 in / $15 out per 1M');
    expect(priceLabel(english, { costInput: 0.25, costOutput: 1.25 })).toBe('$0.25 in / $1.25 out per 1M');
    expect(priceLabel(english, {})).toBe('free');
    expect(modelDetail(english, { provider: 'llama-swap', contextWindow: 262_144 })).toBe(
      'llama-swap · 262k context · free',
    );
  });
});

describe('usage in the transcript model', () => {
  const user = { id: 'u1', role: 'user', content: 'hi' } as Message;
  const assistant = (id: string, calls = false) =>
    ({
      id,
      role: 'assistant',
      content: 'text',
      ...(calls ? { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] } : {}),
    }) as Message;
  const turnUsage = (id: string, input: number, model = 'gemma') =>
    ({
      id: `usage:${id}`,
      role: 'activity',
      activityType: 'pi.turn_usage',
      content: { input, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.5, elapsedMs: 1000, provider: 'p', model },
    }) as Message;

  it('sums the requests of a turn into one block usage and keeps the text, tool call and text in one block', () => {
    const blocks = buildTranscript(english, [
      user,
      assistant('a1', true),
      turnUsage('a1', 100),
      assistant('a2'),
      turnUsage('a2', 200, 'other'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    const block = blocks[1];
    expect(block.kind === 'assistant' && block.usage).toEqual({
      requests: 2,
      input: 300,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 1,
      elapsedMs: 2000,
      models: ['p/gemma', 'p/other'],
    });
  });

  it('has no usage for a block pi reported none for', () => {
    const block = buildTranscript(english, [user, assistant('a1')])[1];
    expect(block.kind === 'assistant' && block.usage).toBeUndefined();
  });
});
