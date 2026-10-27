import { english } from '@pi-kit/i18n/testing';
import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { buildTranscript } from './transcript-model';
import { indexTurns } from './turn-model';

const user = (id: string, content: unknown = 'hi'): Message => ({ id, role: 'user', content }) as Message;
const reasoning = (id: string, content: string): Message => ({ id, role: 'reasoning', content }) as Message;
const assistant = (id: string, content: string, calls: { id: string; name: string }[] = []): Message =>
  ({
    id,
    role: 'assistant',
    content,
    ...(calls.length
      ? { toolCalls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: '{}' } })) }
      : {}),
  }) as Message;
const activity = (id: string, activityType: string, content: Record<string, unknown> = {}): Message =>
  ({ id, role: 'activity', activityType, content }) as Message;
const usage = (id: string, input: number): Message =>
  activity(id, 'pi.turn_usage', {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    elapsedMs: 10,
    model: 'm',
    provider: 'p',
  });

const index = (messages: Message[]) => indexTurns(buildTranscript(english, messages));

describe('indexTurns', () => {
  it('names the last assistant block, the one a running turn adds to (its work group is the one at work)', () => {
    expect(index([user('u1')]).lastBlock).toBeUndefined();
    const idx = index([
      user('u1'),
      assistant('a1', '', [{ id: 'c1', name: 'bash' }]),
      user('u2'),
      assistant('a2', '', [{ id: 'c2', name: 'read' }]),
    ]);
    expect(idx.lastBlock).toBe('a2');
    expect(idx.pieces.get('a1')?.work).toMatchObject({ group: 'a1', unanswered: true });
    expect(idx.pieces.get('a2')?.work).toMatchObject({ group: 'a2', unanswered: true });
  });

  it('numbers the user turns and ties the pieces of a turn to the user message that opened it', () => {
    const idx = index([user('u1'), assistant('a1', 'one'), user('u2'), reasoning('r2', 'hmm'), assistant('a2', 'two')]);
    expect([...idx.turns]).toEqual([
      ['u1', 1],
      ['u2', 2],
    ]);
    expect(idx.pieces.get('a1')).toMatchObject({ kind: 'assistant', after: 'u1', cont: false });
    expect(idx.pieces.get('r2')).toMatchObject({ kind: 'think', after: 'u2', cont: false });
    // The second piece of a block sits 12px under the first one.
    expect(idx.pieces.get('a2')).toMatchObject({ kind: 'assistant', after: 'u2', cont: true });
  });

  it('puts the toolbar on the last answer text, and not when tool calls came after it', () => {
    const answered = index([
      user('u1'),
      assistant('a1', 'I will look', [{ id: 'c1', name: 'read' }]),
      assistant('a2', 'Done.'),
    ]);
    expect(answered.pieces.get('a1')?.toolbar).toBe(false);
    expect(answered.pieces.get('a2')?.toolbar).toBe(true);
    expect(answered.answers.get('a2')).toBe('u1');

    const unfinished = index([user('u1'), assistant('a1', 'Reading first', [{ id: 'c1', name: 'read' }])]);
    expect(unfinished.pieces.get('a1')?.toolbar).toBe(false);
    expect(unfinished.answers.size).toBe(0);
  });

  it('describes steps, the continuation of a list and the fold of a long one', () => {
    const calls = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: 'read' }));
    const idx = index([
      user('u1'),
      assistant('a1', '', calls('c', 3)),
      assistant('a2', '', calls('d', 2)),
      assistant('a3', '', calls('e', 2)),
      assistant('a4', 'End.'),
    ]);
    expect(idx.pieces.get('a1')?.step).toMatchObject({
      index: 1,
      of: 3,
      group: 'a1:activity',
      first: true,
      last: false,
      folds: true,
      earlierCalls: 5,
    });
    expect(idx.pieces.get('a2')?.step).toMatchObject({ index: 2, first: false, last: false });
    expect(idx.pieces.get('a3')?.step).toMatchObject({ index: 3, last: true });
    expect(idx.pieces.get('a1')?.contActivity).toBe(false);
    expect(idx.pieces.get('a2')?.contActivity).toBe(true);
    expect(idx.pieces.get('a3')?.contActivity).toBe(true);
    // The text answer after the list is a piece of its own and gets the toolbar.
    expect(idx.pieces.get('a4')).toMatchObject({ kind: 'assistant', toolbar: true, cont: true });
  });

  it('does not fold a short list', () => {
    const idx = index([
      user('u1'),
      assistant('a1', '', [{ id: 'c1', name: 'read' }]),
      assistant('a2', '', [{ id: 'c2', name: 'read' }]),
    ]);
    expect(idx.pieces.get('a1')?.step?.folds).toBe(false);
  });

  it('keeps the turn usage on the last usage activity of a block only', () => {
    const idx = index([
      user('u1'),
      assistant('a1', 'x', [{ id: 'c1', name: 'read' }]),
      usage('usage:a1', 100),
      assistant('a2', 'y'),
      usage('usage:a2', 50),
    ]);
    expect(idx.usage.has('usage:a1')).toBe(false);
    expect(idx.usage.get('usage:a2')).toMatchObject({ requests: 2, input: 150 });
    expect(idx.pieces.get('usage:a2')).toMatchObject({ kind: 'usage', cont: true });
  });

  it('ends the turn at a compaction marker', () => {
    const idx = index([
      user('u1'),
      assistant('a1', 'x'),
      activity('compaction:k', 'pi.compaction'),
      assistant('a2', 'after'),
    ]);
    expect(idx.pieces.get('a2')?.after).toBeUndefined();
    expect(idx.pieces.get('a2')?.cont).toBe(false);
  });

  it('draws generated UI as a piece of the turn', () => {
    const idx = index([user('u1'), assistant('a1', 'Here is a table'), activity('s1', 'a2ui-surface')]);
    expect(idx.pieces.get('s1')).toMatchObject({ kind: 'genui', after: 'u1', cont: true });
  });
});

describe('the work group', () => {
  it('rows every thought, step and interim text before the answer, counts them, and leaves the answer outside', () => {
    const idx = index([
      user('u1'),
      reasoning('r1', 'Let me look.'),
      assistant('a1', '', [{ id: 'c1', name: 'read' }]),
      assistant('a2', 'Half way.', [
        { id: 'c2', name: 'bash' },
        { id: 'c3', name: 'bash' },
      ]),
      reasoning('r2', 'Nearly.'),
      assistant('a3', 'Done.'),
    ]);
    expect(idx.pieces.get('r1')?.work).toMatchObject({
      group: 'r1',
      row: 0,
      rows: 4,
      first: true,
      last: false,
      calls: 3,
      thinks: 2,
      steps: 2,
      unanswered: false,
    });
    expect(idx.pieces.get('a1')?.work).toMatchObject({ row: 1 });
    expect(idx.pieces.get('a2')?.work).toMatchObject({ row: 2 });
    expect(idx.pieces.get('r2')?.work).toMatchObject({ row: 3, last: true });
    expect(idx.pieces.get('a3')?.work).toBeUndefined();
    expect(idx.pieces.get('a3')?.toolbar).toBe(true);
  });

  it('is unanswered while the block ends on a step, and absent for a block without a step', () => {
    const working = index([user('u1'), assistant('a1', 'Looking…', [{ id: 'c1', name: 'read' }])]);
    expect(working.pieces.get('a1')?.work).toMatchObject({ rows: 1, unanswered: true });
    const plain = index([user('u1'), reasoning('r1', 'Hm.'), assistant('a1', 'Hello.')]);
    expect(plain.pieces.get('r1')?.work).toBeUndefined();
  });
});
