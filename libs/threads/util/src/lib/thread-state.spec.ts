import { english } from '@pi-kit/i18n/testing';
import { idleState, thread } from '@pi-kit/testing';
import { SECTION_HEADERS_ABOVE, groupThreads, matches, sortThreads, threadMeta } from './thread-groups';
import { contextLevel, countStates, shortTime, stateKinds, strongestKind, worstContext } from './thread-state';

describe('stateKinds', () => {
  it('lists the badges strongest first: a question, a failure, a nearly full context, a run, a stop, a filling context, news, the CLI', () => {
    const everything = idleState({ activity: 'waiting', lastRun: 'error', context: 96, unread: true, cli: true });
    expect(stateKinds(everything)).toEqual(['waiting', 'error', 'context-high', 'unread', 'cli']);
    expect(stateKinds(idleState({ activity: 'running', lastRun: 'aborted', context: 72 }))).toEqual([
      'running',
      'aborted',
      'context',
    ]);
    expect(stateKinds(idleState())).toEqual([]);
  });

  it('what the user is looking at is no news: unread and cli do not show on the open thread, a failure still does on its row', () => {
    const state = idleState({ lastRun: 'error', unread: true, cli: true });
    expect(stateKinds(state, { looking: true })).toEqual(['error']);
  });

  it('a project is lit by a stopped or failed run only until it has been seen, and never by the thread that is open', () => {
    const unseen = idleState({ lastRun: 'aborted', unseen: true });
    const seen = idleState({ lastRun: 'aborted', unseen: false });
    expect(stateKinds(unseen, { group: true })).toEqual(['aborted']);
    expect(stateKinds(seen, { group: true })).toEqual([]);
    expect(stateKinds(seen)).toEqual(['aborted']);
    expect(stateKinds(unseen, { group: true, looking: true })).toEqual([]);
  });
});

describe('a project’s state', () => {
  const a = thread('a', { state: idleState({ activity: 'running' }) });
  const b = thread('b', { state: idleState({ context: 95 }) });
  const c = thread('c', { state: idleState({ activity: 'waiting', question: 'Ok?' }) });
  const d = thread('d', { state: idleState({ unread: true, unseen: true, lastRun: 'finished' }) });

  it('shows the strongest state of its threads', () => {
    expect(strongestKind([a, b])).toBe('context-high');
    expect(strongestKind([a, b, c])).toBe('waiting');
    expect(strongestKind([d])).toBe('unread');
    expect(strongestKind([thread('x')])).toBeUndefined();
    // the open thread's own news does not light the project
    expect(strongestKind([d], 'd')).toBeUndefined();
  });

  it('counts what runs and what waits, and finds the fullest context from the warning step', () => {
    expect(countStates([a, b, c, d])).toEqual({ running: 1, waiting: 1 });
    expect(worstContext([a, b, c])).toBe(95);
    expect(worstContext([thread('y', { state: idleState({ context: 60 }) })])).toBeUndefined();
  });

  it('applies one supplied threshold policy to badges and project gauges', () => {
    const thresholds = { warning: 80, error: 98 };
    expect(contextLevel(75, thresholds)).toBeUndefined();
    expect(stateKinds(idleState({ context: 95 }), {}, thresholds)).toEqual(['context']);
    expect(strongestKind([a, b], undefined, thresholds)).toBe('running');
    expect(worstContext([thread('y', { state: idleState({ context: 75 }) })], thresholds)).toBeUndefined();
  });

  it('the gauge has a warning step at 70 and an error step at 90', () => {
    expect([null, 69, 70, 89, 90, 100].map((value) => contextLevel(value))).toEqual([
      undefined,
      undefined,
      'warn',
      'warn',
      'err',
      'err',
    ]);
  });
});

describe('shortTime', () => {
  const now = new Date(2026, 9, 16, 12, 0, 0).getTime();
  it('is now, minutes, hours, a weekday within the week, then the date', () => {
    expect(shortTime(english, now - 20_000, now)).toBe('now');
    expect(shortTime(english, now - 12 * 60_000, now)).toBe('12m');
    expect(shortTime(english, now - 2 * 3_600_000 - 5 * 60_000, now)).toBe('2h');
    expect(shortTime(english, new Date(2026, 9, 13, 9, 0).getTime(), now)).toBe(
      new Date(2026, 9, 13).toLocaleDateString(undefined, { weekday: 'short' }),
    );
    expect(shortTime(english, new Date(2026, 8, 3).getTime(), now)).toBe(
      new Date(2026, 8, 3).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    );
    expect(shortTime(english, new Date(2025, 8, 3).getTime(), now)).toContain('2025');
    expect(shortTime(english, now + 5000, now)).toBe('now');
  });
});

describe('the thread list helpers', () => {
  it('the meta line is the attendant’s summary, else a short fact', () => {
    expect(
      threadMeta(
        english,
        thread('s', { messageCount: 3, forkCount: 0, state: idleState({ summary: 'Writing the summary function' }) }),
      ),
    ).toBe('Writing the summary function');
    expect(threadMeta(english, thread('s', { messageCount: 3, forkCount: 2 } as never))).toBe('3 messages, 2 forks');
    expect(threadMeta(english, thread('s', { messageCount: 1, forkCount: 0 } as never))).toBe('1 message');
    expect(threadMeta(english, thread('s', { messageCount: 0, forkCount: 0 } as never))).toBe('No messages yet');
    expect(
      threadMeta(
        english,
        thread('s', { messageCount: 5, forkCount: 0, state: idleState({ lastRun: 'aborted' }) } as never),
      ),
    ).toBe('Aborted');
    expect(threadMeta(english, thread('s', { messageCount: 5, forkCount: 0, archived: true } as never))).toBe(
      '5 messages, archived',
    );
  });

  it('search also finds the summary', () => {
    const t = thread('s', {
      title: 'Report',
      preview: 'x',
      state: idleState({ summary: 'Writing the monthly digest' }),
    });
    expect(matches(t, 'digest')).toBe(true);
    expect(matches(t, 'nothing')).toBe(false);
  });

  it('a project’s threads are pinned first, then the newest; sections only past the threshold', () => {
    const list = [
      thread('old', { updatedAt: 1 }),
      thread('new', { updatedAt: 9 }),
      thread('pin', { updatedAt: 0, pinned: true }),
    ];
    expect(sortThreads(list).map((t) => t.id)).toEqual(['pin', 'new', 'old']);
    expect(SECTION_HEADERS_ABOVE).toBe(8);
    expect(groupThreads(english, list, new Date(2026, 9, 16).getTime()).map((g) => g.label)).toEqual([
      'Pinned',
      'Older',
    ]);
  });
});
