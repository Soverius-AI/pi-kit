import { describe, expect, it } from 'vitest';
import {
  CommandSchema,
  CreateThreadSchema,
  PatchModelSchema,
  PatchThreadSchema,
  PI_ACTIVITY_TYPES,
  PI_CUSTOM_EVENTS,
  PiDialogAnswerSchema,
  ChangesQuerySchema,
  RevertRequestSchema,
  StageRequestSchema,
  ThreadStateSchema,
  activityId,
  isPiInterruptReason,
  parsePiCustomEvent,
  piInterruptReason,
} from './index';

describe('pi custom events', () => {
  it('defines every name', () => {
    expect(Object.keys(PI_CUSTOM_EVENTS).sort()).toEqual(
      ['pi.compaction', 'pi.composer', 'pi.model', 'pi.notify', 'pi.queue', 'pi.retry', 'pi.session_info', 'pi.status', 'pi.title', 'pi.tree', 'pi.usage'],
    );
  });

  it('parses a valid event and strips unknown keys', () => {
    expect(parsePiCustomEvent({ name: 'pi.queue', value: { steer: 1, followUp: 0, extra: true } })).toEqual({
      name: 'pi.queue',
      value: { steer: 1, followUp: 0 },
    });
  });

  it('rejects an unknown name or a malformed value', () => {
    expect(parsePiCustomEvent({ name: 'pi.nope', value: {} })).toBeUndefined();
    expect(parsePiCustomEvent({ name: 'pi.queue', value: { steer: -1, followUp: 0 } })).toBeUndefined();
    expect(parsePiCustomEvent({ name: 'pi.notify', value: { level: 'fatal', text: 'x' } })).toBeUndefined();
  });

  it('accepts a session name that is cleared', () => {
    expect(parsePiCustomEvent({ name: 'pi.session_info', value: {} })).toEqual({ name: 'pi.session_info', value: {} });
  });
});

describe('pi activities', () => {
  it('validates the content of each activity type', () => {
    expect(PI_ACTIVITY_TYPES['pi.bash'].parse({ command: 'ls', output: '', running: true })).toBeTruthy();
    expect(PI_ACTIVITY_TYPES['pi.diff'].parse({ path: 'a.ts', hunks: [] })).toBeTruthy();
    expect(PI_ACTIVITY_TYPES['pi.widget'].parse({ key: 'k', lines: ['a'] })).toBeTruthy();
    expect(() => PI_ACTIVITY_TYPES['pi.bash'].parse({ command: 'ls' })).toThrow();
  });
});

describe('thread REST schemas', () => {
  it('accepts a partial patch and rejects unknown or empty fields', () => {
    expect(PatchThreadSchema.parse({ pinned: true })).toEqual({ pinned: true });
    expect(PatchThreadSchema.parse({ title: '  Refactor auth  ' })).toEqual({ title: 'Refactor auth' });
    expect(() => PatchThreadSchema.parse({ title: '   ' })).toThrow();
    expect(() => PatchThreadSchema.parse({ sessionPath: '/x' })).toThrow();
  });

  it('requires a cwd to create a thread', () => {
    expect(() => CreateThreadSchema.parse({})).toThrow();
    expect(CreateThreadSchema.parse({ cwd: '/work' })).toEqual({ cwd: '/work' });
  });
});

describe('the Outcome source', () => {
  it('is a source for listing and diffing, not for reverting or staging', () => {
    expect(ChangesQuerySchema.parse({ source: 'outcome' })).toEqual({ source: 'outcome' });
    expect(ChangesQuerySchema.parse({})).toEqual({ source: 'thread' });
    expect(RevertRequestSchema.safeParse({ file: 'a.ts', source: 'outcome', confirm: true }).success).toBe(false);
    expect(RevertRequestSchema.safeParse({ file: 'a.ts', source: 'worktree', confirm: true }).success).toBe(true);
    expect(StageRequestSchema.safeParse({ source: 'outcome' }).success).toBe(false);
  });

  it('is carried by the thread state as a badge or null', () => {
    const state = { activity: 'idle', question: null, context: null, lastRun: null, unread: false, unseen: false, cli: false, summary: null, suggestions: [], draft: null };
    expect(ThreadStateSchema.safeParse({ ...state, outcome: null }).success).toBe(true);
    expect(ThreadStateSchema.safeParse({ ...state, outcome: { kind: 'pr', head: 'abc', at: 1, url: 'https://example.test/pr/1' } }).success).toBe(true);
    expect(ThreadStateSchema.safeParse({ ...state, outcome: { kind: 'reverted', head: 'abc', at: 1 } }).success).toBe(false);
    expect(ThreadStateSchema.safeParse(state).success).toBe(false);
  });
});

describe(' shapes', () => {
  it('validates the tool and compaction activities and derives their message ids', () => {
    expect(PI_ACTIVITY_TYPES['pi.tool'].parse({ toolCallId: 'c', toolName: 'bash', status: 'running', startedAt: 1 })).toBeTruthy();
    expect(() => PI_ACTIVITY_TYPES['pi.tool'].parse({ toolCallId: 'c', toolName: 'bash', status: 'paused', startedAt: 1 })).toThrow();
    expect(PI_ACTIVITY_TYPES['pi.compaction'].parse({})).toEqual({});
    expect(activityId.bash('c1')).toBe('bash:c1');
    expect(activityId.compaction('k')).toBe('compaction:k');
  });

  it('keeps the optional status key and the context token count', () => {
    expect(parsePiCustomEvent({ name: 'pi.status', value: { key: 'git', text: '' } })?.value).toEqual({ key: 'git', text: '' });
    expect(parsePiCustomEvent({ name: 'pi.usage', value: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3 } })).toBeDefined();
  });

  it('names interrupts after the dialog method and parses answers', () => {
    expect(piInterruptReason('confirm')).toBe('pi.ui.confirm');
    expect(isPiInterruptReason('pi.ui.select')).toBe(true);
    expect(isPiInterruptReason('other')).toBe(false);
    expect(PiDialogAnswerSchema.parse({ confirmed: false })).toEqual({ confirmed: false });
    expect(PiDialogAnswerSchema.parse({ value: 'x' })).toEqual({ value: 'x' });
    expect(() => PiDialogAnswerSchema.parse({ value: 1 })).toThrow();
  });

  it('model patches need provider and model together; thinking level alone is fine', () => {
    expect(PatchModelSchema.parse({ thinkingLevel: 'high' })).toEqual({ thinkingLevel: 'high' });
    expect(PatchModelSchema.parse({ provider: 'a', modelId: 'b' })).toEqual({ provider: 'a', modelId: 'b' });
    expect(() => PatchModelSchema.parse({ provider: 'a' })).toThrow();
    expect(() => PatchModelSchema.parse({ thinkingLevel: 'extreme' })).toThrow();
  });

  it('describes a command entry', () => {
    expect(CommandSchema.parse({ name: 'compact', source: 'builtin', kind: 'action' })).toMatchObject({ name: 'compact' });
    expect(() => CommandSchema.parse({ name: 'x', source: 'mystery', kind: 'action' })).toThrow();
  });
});
