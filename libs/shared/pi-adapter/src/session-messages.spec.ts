import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventType, type Message } from '@ag-ui/core';
import { verifyEvents } from '@ag-ui/client';
import { firstValueFrom, from, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { messagesSnapshot } from './event-log';
import { type PiSessionEntry, sessionToMessages } from './session-messages';

/** The recorded session file (`npm run record:fixtures`): tool call, answer, a session name, second turn. */
const entries = readFileSync(join(__dirname, '..', 'fixtures', 'session.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as PiSessionEntry)
  .filter((entry) => entry.type !== 'session');

describe('sessionToMessages (recorded session file)', () => {
  const messages = sessionToMessages(entries);
  const roles = messages.map((m) => m.role);

  it('keeps the conversation order and drops system messages and non-turn entries', () => {
    expect(roles).toEqual([
      'user',
      'reasoning',
      'assistant', // the tool call turn (no text)
      'activity', // pi.turn_usage
      'tool',
      'activity', // pi.tool
      'activity', // pi.bash
      'reasoning',
      'assistant',
      'activity', // pi.turn_usage
      'user',
      'reasoning',
      'assistant',
      'activity', // pi.turn_usage
    ]);
  });

  it('uses the pi entry ids so a snapshot is stable across calls', () => {
    expect(sessionToMessages(entries).map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
    expect(messages[0].id).toBe('b5a58d99');
  });

  it('turns the tool call into a toolCalls entry on the assistant message and pairs the result', () => {
    const call = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(call).toBeDefined();
    const toolCall = (call as Extract<Message, { role: 'assistant' }>).toolCalls![0];
    expect(toolCall.function.name).toBe('bash');
    expect(JSON.parse(toolCall.function.arguments)).toMatchObject({ command: expect.stringContaining('cat note.txt') });

    const result = messages.find((m) => m.role === 'tool') as Extract<Message, { role: 'tool' }>;
    expect(result.toolCallId).toBe(toolCall.id);
    expect(result.content).toBe('hello pi-kit\n');
    expect(result.error).toBeUndefined();
  });

  it('flattens user text blocks to a string and carries assistant text', () => {
    expect(messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining("run 'cat note.txt'") });
    const last = messages.filter((m) => m.role === 'assistant').at(-1) as Extract<Message, { role: 'assistant' }>;
    expect(last.content?.length).toBeGreaterThan(0);
  });

  it('gives every assistant message a pi.turn_usage activity from its stored usage', () => {
    const usage = messages.filter((m) => m.role === 'activity' && (m as { activityType?: string }).activityType === 'pi.turn_usage');
    const assistants = entries.filter((e) => e.type === 'message' && (e['message'] as { role: string }).role === 'assistant');
    expect(usage).toHaveLength(assistants.length);
    expect(usage.map((u) => u.id)).toEqual(assistants.map((a) => `usage:${a.id}`));
    const stored = (assistants[0]['message'] as { usage: { input: number; cacheRead: number } }).usage;
    expect((usage[0] as unknown as { content: { input: number; cacheRead: number; model?: string } }).content).toMatchObject({ input: stored.input, cacheRead: stored.cacheRead });
  });

  it('produces messages AG-UI accepts in a MESSAGES_SNAPSHOT inside a run', async () => {
    const events = [
      { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
      messagesSnapshot(messages),
      { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'success' } },
    ] as never[];
    await expect(firstValueFrom(from(events).pipe(verifyEvents(false), toArray()))).resolves.toHaveLength(3);
  });
});

describe('sessionToMessages (edge cases)', () => {
  const entry = (extra: Record<string, unknown>): PiSessionEntry => ({ type: 'message', id: 'e1', parentId: null, ...extra });

  it('maps images, error results, extra text blocks and display-only custom messages', () => {
    const out = sessionToMessages([
      entry({ message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } }),
      entry({
        id: 'e2',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } },
          ],
        },
      }),
      entry({ id: 'e3', message: { role: 'toolResult', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'ENOENT' }] } }),
      { type: 'custom_message', id: 'e4', parentId: 'e3', customType: 'x', content: 'note', display: true },
      { type: 'custom_message', id: 'e5', parentId: 'e4', customType: 'x', content: 'hidden', display: false },
    ]);
    expect(out[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'data', value: 'AAAA' } }],
    });
    expect(out[1]).toMatchObject({ id: 'e2', role: 'assistant', content: 'one' });
    expect(out[2]).toMatchObject({ id: 'e2:1', role: 'assistant', content: 'two' });
    expect(out[3]).toMatchObject({ role: 'tool', error: 'ENOENT' });
    expect(out[4]).toMatchObject({ id: 'tool:c1', role: 'activity', activityType: 'pi.tool', content: { status: 'error', toolName: 'read' } });
    expect(out[5]).toMatchObject({ id: 'e4', content: 'note' });
    expect(out).toHaveLength(6);
  });

  it('brings back the activities the live stream carries: bash, edit and write diffs, user bash, compaction', () => {
    const patch = 'Index: a.ts\n====\n--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n';
    const out = sessionToMessages([
      entry({ id: 'u1', message: { role: 'user', content: 'go' } }),
      entry({
        id: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'false' } },
            { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'c3', name: 'write', arguments: { path: 'b.ts', content: 'x\ny\n' } },
          ],
        },
      }),
      entry({ id: 't1', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', isError: true, durationMs: 40, timestamp: 1000, content: [{ type: 'text', text: 'boom\n\nCommand exited with code 1' }] } }),
      entry({ id: 't2', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], details: { patch } } }),
      entry({ id: 't3', message: { role: 'toolResult', toolCallId: 'c3', toolName: 'write', content: [{ type: 'text', text: 'ok' }] } }),
      entry({ id: 'b1', message: { role: 'bashExecution', command: 'ls', output: 'f\n', exitCode: 0, cancelled: false, truncated: false } }),
      { type: 'compaction', id: 'k1', parentId: 'b1', firstKeptEntryId: 'u1', tokensBefore: 5000, summary: 'earlier work' },
    ]);
    const act = (id: string) => out.find((m) => m.id === id) as unknown as { activityType: string; content: Record<string, unknown> };
    expect(act('tool:c1').content).toMatchObject({ status: 'error', durationMs: 40, startedAt: 960 });
    expect(act('bash:c1').content).toMatchObject({ command: 'false', exitCode: 1, running: false });
    expect(act('diff:c2').content).toMatchObject({ path: 'a.ts', toolCallId: 'c2' });
    expect((act('diff:c2').content['hunks'] as unknown[]).length).toBe(1);
    expect(act('diff:c3').content).toMatchObject({ path: 'b.ts', written: true });
    expect(act('bash:user:b1').content).toMatchObject({ command: 'ls', output: 'f\n', exitCode: 0, user: true });
    expect(act('compaction:u1')).toMatchObject({ activityType: 'pi.compaction', content: { tokensBefore: 5000, summary: 'earlier work' } });
    expect(out.at(-1)?.id).toBe('compaction:u1');
  });

  it('marks a branch summary with an activity, so the transcript of a branch says what it carries over', () => {
    const out = sessionToMessages([
      entry({ id: 'u1', message: { role: 'user', content: 'go' } }),
      { type: 'branch_summary', id: 's1', parentId: 'u1', fromId: 'zz', summary: 'The other branch tried X.' },
      entry({ id: 'u2', message: { role: 'user', content: 'next' } }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['u1', 'branch-summary:s1', 'u2']);
    expect(out[1]).toMatchObject({ role: 'activity', activityType: 'pi.branch_summary', content: { summary: 'The other branch tried X.' } });
  });

  it('puts the review batch of a pi-kit.review custom entry right after the user message it was sent with', () => {
    const comments = [{ id: 'c1', file: 'src/a.ts', side: 'new', line: 12, snippet: 'const x = 1;', text: 'Name this constant.' }];
    const branch: PiSessionEntry[] = [
      { type: 'custom', id: 'r1', customType: 'pi-kit.review', data: { comments } },
      { type: 'message', id: 'u1', message: { role: 'user', content: 'I reviewed your changes and left 1 comment.' } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
      // a custom entry of another extension, and one with a malformed batch, change nothing
      { type: 'custom', id: 'r2', customType: 'something-else', data: { comments } },
      { type: 'custom', id: 'r3', customType: 'pi-kit.review', data: { comments: [] } },
      { type: 'message', id: 'u2', message: { role: 'user', content: 'thanks' } },
    ];
    const out = sessionToMessages(branch);
    expect(out.map((m) => m.role)).toEqual(['user', 'activity', 'assistant', 'user']);
    expect(out[1]).toMatchObject({ id: 'review:r1', activityType: 'pi.review', content: { comments } });
  });

  it('shows a skill invocation as the user typed it, not as the skill file pi stored', () => {
    const block = '<skill name="pdf-tools" location="/s/pdf/SKILL.md">\nReferences are relative to /s/pdf.\n\nDo PDF things.\n</skill>';
    const out = sessionToMessages([
      entry({ id: 'u1', message: { role: 'user', content: block } }),
      entry({ id: 'u2', message: { role: 'user', content: [{ type: 'text', text: `${block}\n\nmerge a.pdf b.pdf` }] } }),
    ]);
    expect(out[0]).toMatchObject({ content: '/skill:pdf-tools' });
    expect(out[1]).toMatchObject({ content: '/skill:pdf-tools merge a.pdf b.pdf' });
  });

  it('shows several skill blocks of a message with chips as the invocations they stand for', () => {
    const a = '<skill name="alpha" location="/s/a/SKILL.md">\nReferences are relative to /s/a.\n\nAlpha.\n</skill>';
    const b = '<skill name="beta" location="/s/b/SKILL.md">\nReferences are relative to /s/b.\n\nBeta.\n</skill>';
    const out = sessionToMessages([entry({ id: 'u1', message: { role: 'user', content: `${a}\n\n${b}\n\ndo it` } }), entry({ id: 'u2', message: { role: 'user', content: `${a}\n\n${b}` } })]);
    expect(out[0]).toMatchObject({ content: '/skill:alpha /skill:beta do it' });
    expect(out[1]).toMatchObject({ content: '/skill:alpha /skill:beta' });
  });

  it('draws a message with chips as typed, with a pi.skills activity, from the pi-kit.skills entry before it', () => {
    const chips = [
      { kind: 'skill', name: 'alpha', pinned: false, scope: 'project' },
      { kind: 'prompt', name: 'review', pinned: true },
    ];
    const out = sessionToMessages([
      { type: 'custom', id: 's1', customType: 'pi-kit.skills', data: { chips, text: 'check @a.ts' } },
      { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '<skill name="alpha" location="/s/SKILL.md">\nx\n</skill>\n\nReview.\n\ncheck @a.ts' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      // a malformed entry changes nothing
      { type: 'custom', id: 's2', customType: 'pi-kit.skills', data: { chips: [], text: 'x' } },
      { type: 'message', id: 'u2', message: { role: 'user', content: 'plain' } },
      { type: 'custom', id: 's3', customType: 'pi-kit.skills', data: { chips: [chips[0]], text: '' } },
      { type: 'message', id: 'u3', message: { role: 'user', content: '<skill name="alpha" location="/s/SKILL.md">\nx\n</skill>' } },
    ] as PiSessionEntry[]);
    expect(out.map((m) => m.role)).toEqual(['user', 'activity', 'assistant', 'user', 'user', 'activity']);
    expect(out[0]).toMatchObject({ id: 'u1', content: [{ type: 'text', text: 'check @a.ts' }, { type: 'image' }] });
    expect(out[1]).toMatchObject({ id: 'skills:s1', activityType: 'pi.skills', content: { chips } });
    expect(out[3]).toMatchObject({ id: 'u2', content: 'plain' });
    expect(out[4]).toMatchObject({ id: 'u3', content: '' });
    expect(out[5]).toMatchObject({ id: 'skills:s3', activityType: 'pi.skills' });
  });

  it('drops the file contents the composer inlined for @paths, keeping what the user typed', () => {
    const out = sessionToMessages([
      entry({ id: 'u1', message: { role: 'user', content: '<file name="/w/a.ts">\nexport const a = 1;\n\n</file>\n<file name="/w/b.ts">\nb\n\n</file>\nwhat is in @a.ts and @b.ts?' } }),
    ]);
    expect(out[0]).toMatchObject({ content: 'what is in @a.ts and @b.ts?' });
  });

  it('answers a tool call the conversation moved past, but not one that is still the last thing', () => {
    const call = entry({
      id: 'a1',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c9', name: 'bash', arguments: {} }], stopReason: 'toolUse' },
    });
    const next = entry({ id: 'u2', message: { role: 'user', content: 'continue' } });

    const pending = sessionToMessages([call]);
    expect(pending.map((m) => m.role)).toEqual(['assistant']);

    const moved = sessionToMessages([call, next]);
    expect(moved.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(moved[1]).toMatchObject({ toolCallId: 'c9', error: 'interrupted' });
  });

  it('returns nothing for an empty branch and skips assistant messages without content', () => {
    expect(sessionToMessages([])).toEqual([]);
    expect(sessionToMessages([entry({ message: { role: 'assistant', content: [], stopReason: 'aborted' } })])).toEqual([]);
  });
});

describe('sessionToMessages (generative UI)', () => {
  const ops = [{ version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'c' } }];
  const turn = (details: unknown, text = 'Showed it.', callName = 'show'): PiSessionEntry[] => [
    { type: 'message', id: 'a1', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: callName, arguments: { q: 1 } }] } },
    { type: 'message', id: 'r1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'call1', toolName: callName, content: [{ type: 'text', text }], details, isError: false } },
  ];
  const surfaces = (out: Message[], type: string) => out.filter((m) => m.role === 'activity' && (m as { activityType?: string }).activityType === type);

  it('rebuilds an a2ui-surface activity from details.a2ui_operations or from a JSON result text, under the id the stream used', () => {
    const fromDetails = sessionToMessages(turn({ a2ui_operations: ops }));
    expect(surfaces(fromDetails, 'a2ui-surface')).toEqual([
      { id: 'a2ui-surface-call1', role: 'activity', activityType: 'a2ui-surface', content: { a2ui_operations: ops } },
    ]);
    const fromText = sessionToMessages(turn(undefined, JSON.stringify({ a2ui_operations: ops })));
    expect(surfaces(fromText, 'a2ui-surface')[0]).toMatchObject({ id: 'a2ui-surface-call1', content: { a2ui_operations: ops } });
    expect(surfaces(sessionToMessages(turn({ other: 1 })), 'a2ui-surface')).toHaveLength(0);
  });

  it('rebuilds a stored surface with its data as an object, whichever way the extension wrote it', () => {
    const specs = [{ spec: 'export.spec.ts:41' }];
    const model = (path: string, value: unknown) => ({ version: 'v0.9', updateDataModel: { surfaceId: 's1', path, value } });
    const contentOf = (details: unknown) => (surfaces(sessionToMessages(turn(details)), 'a2ui-surface')[0] as unknown as { content: { a2ui_operations: unknown[] } }).content.a2ui_operations;
    expect(contentOf({ a2ui_operations: [...ops, model('/specs', specs)] })).toEqual([...ops, model('/', { specs })]);
    expect(contentOf({ a2ui_operations: [...ops, model('/', { specs })] })).toEqual([...ops, model('/', { specs })]);
  });

  it('rebuilds an mcp-apps activity when the lookup knows the tool, with the stored result and the call input', () => {
    const entries = turn({ server: 'issues', tool: 'open_form' }, 'Form opened', 'mcp__issues__open_form');
    const mcpApp = (server: string, tool: string) => (server === 'issues' && tool === 'open_form' ? 'ui://issues/form' : undefined);
    expect(surfaces(sessionToMessages(entries, { mcpApp }), 'mcp-apps')).toEqual([
      {
        id: 'mcp-app:call1',
        role: 'activity',
        activityType: 'mcp-apps',
        content: {
          serverHash: 'pi-mcp:issues',
          serverId: 'issues',
          tool: 'open_form',
          resourceUri: 'ui://issues/form',
          result: { content: [{ type: 'text', text: 'Form opened' }] },
          toolInput: { q: 1 },
        },
      },
    ]);
    expect(surfaces(sessionToMessages(entries), 'mcp-apps')).toHaveLength(0);
  });
});

describe("a background agent's report in the session file", () => {
  it('is a user-side note attributed to the agent, with the id its live envelope used', () => {
    const entries: PiSessionEntry[] = [
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'go' } },
      { type: 'custom_message', id: 'r1', parentId: 'u1', customType: 'pikit.agent-report', display: true, content: 'Report from agent "tester": done', details: { agentId: '7', name: 'tester', reportId: 'rep-1' } } as unknown as PiSessionEntry,
      { type: 'custom_message', id: 'n1', parentId: 'r1', customType: 'pi-kit:coordination', display: true, content: 'note' } as unknown as PiSessionEntry,
    ];
    const messages = sessionToMessages(entries);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'r1', 'n1']);
    expect(messages[1]).toMatchObject({ role: 'user', content: 'Report from agent "tester": done', subagentRunId: '7/rep-1', subagentName: 'tester' });
    expect((messages[2] as { subagentRunId?: string }).subagentRunId).toBeUndefined();
  });
});
