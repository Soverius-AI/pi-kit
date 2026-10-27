import { english } from '@pi-kit/i18n/testing';
import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { activityMap, buildTranscript, callsOf } from './transcript-model';

const user = (id: string, content: unknown = 'hi'): Message => ({ id, role: 'user', content }) as Message;
const reasoning = (id: string, content: string): Message => ({ id, role: 'reasoning', content }) as Message;
const assistant = (id: string, content: string, calls: { id: string; name: string; args?: string }[] = []): Message =>
  ({
    id,
    role: 'assistant',
    content,
    ...(calls.length
      ? {
          toolCalls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.args ?? '{}' },
          })),
        }
      : {}),
  }) as Message;
const tool = (id: string, toolCallId: string, content: string, error?: string): Message =>
  ({ id, role: 'tool', toolCallId, content, ...(error ? { error } : {}) }) as Message;
const activity = (id: string, activityType: string, content: Record<string, unknown> = {}): Message =>
  ({ id, role: 'activity', activityType, content }) as Message;

describe('buildTranscript', () => {
  it('groups a user turn and the assistant work that follows it, in the order it happened', () => {
    const blocks = buildTranscript(english, [
      user('u1', 'map the events'),
      reasoning('a1:r0', 'The adapter needs tool events.'),
      assistant('a1', "I'll read the adapter first.", [{ id: 'c1', name: 'read' }]),
      tool('t1', 'c1', 'file text'),
      reasoning('a2:r0', 'Now edit.'),
      assistant('a2', '', [
        { id: 'c2', name: 'edit' },
        { id: 'c3', name: 'bash' },
      ]),
      tool('t2', 'c2', 'ok'),
      assistant('a3', 'Done.'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    const block = blocks[1];
    if (block.kind !== 'assistant') throw new Error('assistant block expected');
    expect(block.items.map((i) => i.kind)).toEqual(['think', 'text', 'activity', 'think', 'activity', 'text']);
    expect(block.stepCount).toBe(2);
    expect(callsOf(block).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(callsOf(block)[0]).toMatchObject({ name: 'read', result: 'file text', messageId: 'a1' });
    expect(callsOf(block)[2].result).toBeUndefined();
  });

  it('keeps consecutive tool calls in one activity list across steps, and numbers the steps', () => {
    const [, block] = buildTranscript(english, [
      user('u1'),
      assistant('a1', '', [{ id: 'c1', name: 'read' }]),
      assistant('a2', '', [
        { id: 'c2', name: 'grep' },
        { id: 'c3', name: 'ls' },
      ]),
    ]);
    if (block.kind !== 'assistant') throw new Error('assistant block expected');
    expect(block.items).toHaveLength(1);
    const item = block.items[0];
    if (item.kind !== 'activity') throw new Error('activity expected');
    expect(item.steps.map((s) => [s.index, s.calls.length])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(item.callCount).toBe(3);
  });

  it('splits at a user message that arrives mid-run and at a compaction marker', () => {
    const blocks = buildTranscript(english, [
      user('u1'),
      assistant('a1', 'working'),
      user('u2', 'and also this'),
      assistant('a2', 'ok'),
      activity('compaction:k1', 'pi.compaction', { tokensBefore: 51000, tokensAfter: 18000 }),
      assistant('a3', 'after'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'user', 'assistant', 'marker', 'assistant']);
    expect(blocks[4]).toMatchObject({ kind: 'marker', tokensBefore: 51000, tokensAfter: 18000 });
  });

  it('makes a marker of a branch summary', () => {
    const blocks = buildTranscript(english, [
      user('u1'),
      activity('branch-summary:s1', 'pi.branch_summary', { summary: 'x' }),
      user('u2'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'marker', 'user']);
    expect(blocks[1]).toMatchObject({ kind: 'marker', label: 'Summary of the branch you left' });
  });

  it('makes a shell block of a command the user ran, and ends the assistant block before it', () => {
    const blocks = buildTranscript(english, [
      user('u1'),
      assistant('a1', 'one'),
      activity('bash:user:b1', 'pi.bash', { command: 'ls', output: '', running: false, user: true }),
      activity('bash:c9', 'pi.bash', { command: 'ls', output: '', running: false }),
      assistant('a2', 'two'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'shell', 'assistant']);
    expect(blocks[2]).toEqual({ kind: 'shell', id: 'bash:user:b1' });
  });

  it('ignores empty reasoning and assistant messages, system messages and the other activities', () => {
    const blocks = buildTranscript(english, [
      { id: 's', role: 'system', content: 'x' } as Message,
      user('u1'),
      reasoning('r', '   '),
      assistant('a1', ''),
      activity('tool:c1', 'pi.tool'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    if (blocks[1].kind === 'assistant') expect(blocks[1].items).toEqual([]);
  });

  it('puts generated UI (an A2UI surface, an MCP App) in the assistant block, after the tool call that made it', () => {
    const blocks = buildTranscript(english, [
      user('u1'),
      assistant('a1', 'Three specs fail.', [{ id: 'c1', name: 'show_failing_specs' }]),
      activity('tool:c1', 'pi.tool'),
      activity('a2ui-surface-c1', 'a2ui-surface', { a2ui_operations: [] }),
      tool('t1', 'c1', 'Showed it.'),
      assistant('a2', 'Press Run.', [{ id: 'c2', name: 'mcp__issues__open_form' }]),
      activity('mcp-app:c2', 'mcp-apps', { resourceUri: 'ui://x' }),
      activity('c3-activity', 'open-generative-ui', { html: ['<head></head><body>Chart</body>'] }),
    ]);
    expect(blocks).toHaveLength(2);
    const items = (blocks[1] as { items: { kind: string; id: string; activityType?: string }[] }).items;
    expect(items.map((i) => i.kind)).toEqual(['text', 'activity', 'genui', 'text', 'activity', 'genui', 'genui']);
    expect(items[2]).toMatchObject({
      id: 'a2ui-surface-c1',
      activityType: 'a2ui-surface',
      content: { a2ui_operations: [] },
    });
    expect(items[5]).toMatchObject({ id: 'mcp-app:c2', activityType: 'mcp-apps' });
    expect(items[6]).toMatchObject({ id: 'c3-activity', activityType: 'open-generative-ui' });
  });

  it('attaches the review comments of a pi.review activity to the user message before it', () => {
    const comments = [{ id: 'c1', file: 'a.ts', side: 'new', line: 3, snippet: 'x', text: 'why' }];
    const blocks = buildTranscript(english, [
      user('u1', 'I reviewed your changes and left 1 comment.'),
      activity('review:r1', 'pi.review', { comments }),
      assistant('a1', 'Fixed.'),
      // a review activity with nothing before it to belong to, or with no comments, is ignored
      activity('review:r2', 'pi.review', { comments: [] }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    expect(blocks[0]).toMatchObject({ kind: 'user', review: comments });
  });

  it('attaches the chips of a pi.skills activity to the user message before it, with or without a sentence', () => {
    const chips = [
      { kind: 'skill', name: 'alpha', pinned: false, scope: 'project' },
      { kind: 'prompt', name: 'review', pinned: true },
    ];
    const blocks = buildTranscript(english, [
      user('u1', 'check the parser'),
      activity('skills:s1', 'pi.skills', { chips }),
      assistant('a1', 'Done.'),
      user('u2', ''),
      activity('skills:s2', 'pi.skills', { chips: [chips[0]] }),
      // no chips: ignored
      activity('skills:s3', 'pi.skills', { chips: [] }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'assistant', 'user']);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'check the parser', skills: chips });
    expect(blocks[2]).toMatchObject({ kind: 'user', text: '', skills: [chips[0]] });
  });

  it('flattens user content parts and turns data images into data URLs', () => {
    const [block] = buildTranscript(english, [
      user('u1', [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } },
      ]),
    ]);
    expect(block).toEqual({ kind: 'user', id: 'u1', text: 'look', images: ['data:image/png;base64,AAAA'] });
  });

  it('attaches the tool error when pi reported one', () => {
    const [, block] = buildTranscript(english, [
      user('u'),
      assistant('a', '', [{ id: 'c', name: 'read' }]),
      tool('t', 'c', 'ENOENT', 'ENOENT'),
    ]);
    if (block.kind !== 'assistant') throw new Error('assistant block expected');
    expect(callsOf(block)[0]).toMatchObject({ result: 'ENOENT', error: 'ENOENT' });
  });
});

describe('activityMap', () => {
  it('indexes activity messages by id', () => {
    const map = activityMap([
      user('u'),
      activity('bash:c1', 'pi.bash', { running: true }),
      activity('diff:c2', 'pi.diff'),
    ]);
    expect([...map.keys()]).toEqual(['bash:c1', 'diff:c2']);
  });
});
