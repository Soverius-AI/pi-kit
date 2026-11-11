import { applyImmutable, type Op } from '@earendil-works/chord/delta';
import type { ConversationView } from '@earendil-works/pi-durable';
import { applyPatch } from 'fast-json-patch';
import { describe, expect, it } from 'vitest';
import { DocsPatch } from './docs-patch';

type Docs = ConversationView['docs'];

/**
 * The patch and stream changes for `ops` against `before`, and what the patch makes of the client's `{ docs }` next to what pi's
 * operations make of them, both without the answer being streamed.
 */
const translate = (before: Docs, ops: Op[]) => {
  const after = applyImmutable<{ docs: Docs }>(
    { docs: before },
    ops.filter((op) => op[0] !== 'r' && op[1][0] === 'docs'),
  ).docs;
  const next = new DocsPatch(before).next(ops, after);
  return {
    patch: next?.patch,
    changes: next?.changes,
    applied:
      next && applyPatch(structuredClone({ docs: DocsPatch.strip(before) }), structuredClone(next.patch)).newDocument,
    expected: { docs: DocsPatch.strip(after) },
  };
};
const message = ['docs', 'pi.live', 'generation', 'message'] as const;
const slot = (callId: string) => ({ callId, name: 'bash', status: 'running' });
const live = { 'pi.live': { run: { turns: 0 }, tools: [slot('a'), slot('b'), slot('c')] } };

describe('DocsPatch (pi view operations as JSON Patch and stream changes)', () => {
  it('turns a set into an add where nothing was, a replace where something was, and an add at an array’s end', () => {
    const { patch, applied, expected } = translate(live, [
      ['s', ['docs', 'pi.live', 'generation'], { attempt: 1 }],
      ['s', ['docs', 'pi.live', 'run', 'turns'], 1],
      ['s', ['docs', 'pi.live', 'tools', 3], slot('d')],
      ['s', ['docs', 'pi.inbox'], { items: [] }],
    ]);
    expect(patch).toEqual([
      { op: 'add', path: '/docs/pi.live/generation', value: { attempt: 1 } },
      { op: 'replace', path: '/docs/pi.live/run/turns', value: 1 },
      { op: 'add', path: '/docs/pi.live/tools/3', value: slot('d') },
      { op: 'add', path: '/docs/pi.inbox', value: { items: [] } },
    ]);
    expect(applied).toEqual(expected);
  });

  it('turns a delete into a remove, of an object member and of an array element', () => {
    const { patch, applied, expected } = translate(live, [
      ['d', ['docs', 'pi.live', 'run']],
      ['d', ['docs', 'pi.live', 'tools', 0]],
    ]);
    expect(patch).toEqual([
      { op: 'remove', path: '/docs/pi.live/run' },
      { op: 'remove', path: '/docs/pi.live/tools/0' },
    ]);
    expect(applied).toEqual(expected);
  });

  it('replaces a string appended to or trimmed with its new value, as JSON Patch has no append', () => {
    const before = { 'pi.live': { tools: [{ ...slot('a'), output: 'one\n' }] } };
    const { patch, applied, expected } = translate(before, [
      ['a', ['docs', 'pi.live', 'tools', 0, 'output'], 'two\n'],
      ['t', ['docs', 'pi.live', 'tools', 0, 'output'], 4],
      ['a', ['docs', 'pi.live', 'tools', 0, 'output'], 'three\n'],
    ]);
    expect(patch).toEqual([
      { op: 'replace', path: '/docs/pi.live/tools/0/output', value: 'one\ntwo\n' },
      { op: 'replace', path: '/docs/pi.live/tools/0/output', value: 'two\n' },
      { op: 'replace', path: '/docs/pi.live/tools/0/output', value: 'two\nthree\n' },
    ]);
    expect(applied).toEqual(expected);
  });

  it('turns a splice into the removes of its deleted items, then the adds of its new ones', () => {
    const { patch, applied, expected } = translate(live, [
      ['p', ['docs', 'pi.live', 'tools'], 1, 2, [slot('x'), slot('y'), slot('z')]],
    ]);
    expect(patch).toEqual([
      { op: 'remove', path: '/docs/pi.live/tools/1' },
      { op: 'remove', path: '/docs/pi.live/tools/1' },
      { op: 'add', path: '/docs/pi.live/tools/1', value: slot('x') },
      { op: 'add', path: '/docs/pi.live/tools/2', value: slot('y') },
      { op: 'add', path: '/docs/pi.live/tools/3', value: slot('z') },
    ]);
    expect(applied).toEqual(expected);
  });

  it('replaces a permuted array with its new order', () => {
    const { patch, applied, expected } = translate(live, [['m', ['docs', 'pi.live', 'tools'], [2, 0, 1]]]);
    expect(patch).toEqual([{ op: 'replace', path: '/docs/pi.live/tools', value: [slot('c'), slot('a'), slot('b')] }]);
    expect(applied).toEqual(expected);
  });

  it('leaves the answer being streamed out of the patch and reports pi’s own appends to it, in order', () => {
    const answer = { role: 'assistant', content: [{ type: 'text', text: '' }] };
    const { patch, changes, applied, expected } = translate({ 'pi.live': {} }, [
      ['s', ['docs', 'pi.live', 'generation'], { attempt: 1, message: answer }],
      ['a', [...message, 'content', 0, 'text'], 'Hel'],
      ['a', [...message, 'content', 0, 'text'], 'lo'],
      ['s', ['docs', 'pi.live', 'generation', 'attempt'], 2],
    ]);
    expect(patch).toEqual([
      { op: 'add', path: '/docs/pi.live/generation', value: { attempt: 1 } },
      { op: 'replace', path: '/docs/pi.live/generation/attempt', value: 2 },
    ]);
    expect(changes).toEqual([
      { kind: 'message', message: answer },
      { kind: 'append', index: 0, field: 'text', text: 'Hel' },
      { kind: 'append', index: 0, field: 'text', text: 'lo' },
    ]);
    expect(applied).toEqual(expected);
    expect(expected).toEqual({ docs: { 'pi.live': { generation: { attempt: 2 } } } });
  });

  it('reports the blocks appended to the answer, thinking appends, and a rewrite of its text as a new answer', () => {
    const before = {
      'pi.live': { generation: { attempt: 1, message: { content: [{ type: 'thinking', thinking: 'Hm' }] } } },
    };
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} };
    const { patch, changes } = translate(before, [
      ['a', [...message, 'content', 0, 'thinking'], 'm.'],
      ['p', [...message, 'content'], 1, 0, [{ type: 'text', text: 'Li' }]],
      ['s', [...message, 'content', 2], call],
      ['s', [...message, 'content', 2, 'arguments', 'command'], 'ls'],
      ['s', [...message, 'usage'], { output: 3 }],
      ['t', [...message, 'content', 1, 'text'], 1],
    ]);
    expect(patch).toEqual([]);
    expect(changes?.map((change) => change.kind)).toEqual(['append', 'block', 'block', 'message']);
    expect(changes?.[0]).toEqual({ kind: 'append', index: 0, field: 'thinking', text: 'm.' });
    expect(changes?.[2]).toEqual({ kind: 'block', index: 2, block: call });
    expect(changes?.[3]).toMatchObject({ message: { content: [{ thinking: 'Hmm.' }, { text: 'i' }, call] } });
  });

  it('reports the answer gone and the entries appended in the order pi committed them', () => {
    const before = { 'pi.live': { run: { turns: 0 }, generation: { attempt: 1, message: { content: [] } } } };
    const entry = { id: 3, conversationId: 1, kind: 'pi.assistant' };
    const { patch, changes, applied, expected } = translate(before, [
      ['d', ['docs', 'pi.live', 'generation']],
      ['p', ['entries'], 2, 0, [entry]],
      ['s', ['docs', 'pi.live', 'generation'], { attempt: 1 }],
      ['s', [...message], { content: [] }],
      ['d', [...message]],
    ]);
    expect(changes).toEqual([
      { kind: 'gone' },
      { kind: 'entry', entry },
      { kind: 'message', message: { content: [] } },
      { kind: 'gone' },
    ]);
    expect(patch).toEqual([
      { op: 'remove', path: '/docs/pi.live/generation' },
      { op: 'add', path: '/docs/pi.live/generation', value: { attempt: 1 } },
    ]);
    expect(applied).toEqual(expected);
  });

  it('keeps the window and the conversation out of the patch, and asks for snapshots when the whole view is replaced', () => {
    const entry = { id: 1, conversationId: 1, kind: 'pi.user' };
    const { patch, changes } = translate(live, [
      ['p', ['entries'], 0, 0, [entry]],
      ['p', ['entries'], 0, 1, []],
      ['s', ['before'], 1],
      ['s', ['conversation', 'title'], 'x'],
    ]);
    expect(patch).toEqual([]);
    expect(changes).toEqual([{ kind: 'entry', entry }]);
    const docs = new DocsPatch(live);
    expect(
      docs.next(
        [
          ['s', ['docs', 'pi.live', 'run', 'turns'], 1],
          ['r', { docs: {}, entries: [] }],
        ],
        {},
      ),
    ).toBeNull();
    expect(docs.next([['s', ['docs', 'pi.inbox'], { items: [] }]], { 'pi.inbox': { items: [] } })).toEqual({
      patch: [{ op: 'add', path: '/docs/pi.inbox', value: { items: [] } }],
      changes: [],
    });
  });

  it('escapes `~` as `~0` and `/` as `~1` in its pointers', () => {
    expect(DocsPatch.pointer(['docs', 'ext/notes~v2', 'a~/b', 0])).toBe('/docs/ext~1notes~0v2/a~0~1b/0');
    const { patch, applied, expected } = translate({ 'ext/notes~v2': { n: 1 } }, [
      ['s', ['docs', 'ext/notes~v2', 'n'], 2],
      ['s', ['docs', 'ext/notes~v2', 'a~/b'], true],
    ]);
    expect(patch).toEqual([
      { op: 'replace', path: '/docs/ext~1notes~0v2/n', value: 2 },
      { op: 'add', path: '/docs/ext~1notes~0v2/a~0~1b', value: true },
    ]);
    expect(applied).toEqual(expected);
  });

  it('strips the answer being streamed from the documents, and nothing else', () => {
    const docs = {
      'pi.live': { run: { turns: 1 }, generation: { attempt: 2, message: { content: [] } } },
      'pi.inbox': {},
    };
    expect(DocsPatch.strip(docs)).toEqual({
      'pi.live': { run: { turns: 1 }, generation: { attempt: 2 } },
      'pi.inbox': {},
    });
    expect(DocsPatch.strip({ 'pi.live': { run: { turns: 1 } } })).toEqual({ 'pi.live': { run: { turns: 1 } } });
    expect(docs['pi.live'].generation.message).toEqual({ content: [] });
  });
});
