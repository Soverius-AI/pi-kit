import { english, german } from '@pi-kit/i18n/testing';
import { idleState, thread } from '@pi-kit/testing';
import type { ThreadSuggestion } from '@pi-kit/protocol';
import {
  TILE_HUES,
  answerChips,
  collapsedTags,
  gaugeBesideStatus,
  hasCliMark,
  needsYou,
  statusLine,
  summaryLine,
  tileHue,
  tileLetter,
} from './sidebar';

const answer = (target: string, text: string, id = 1): ThreadSuggestion => ({ id, kind: 'answer', target, text });

describe('tileHue and tileLetter', () => {
  it('gives a project the same colour every time, from the theme’s own hues, whatever the case or the spaces', () => {
    expect(tileHue('pi-kit')).toBe(tileHue('pi-kit'));
    expect(tileHue('  Pi-Kit ')).toBe(tileHue('pi-kit'));
    for (const name of ['pi-kit', 'reporting-api', 'notes', 'docs', 'Älgen', 'x', ''])
      expect(TILE_HUES).toContain(tileHue(name));
  });

  it('spreads names over the hues (not all the same colour)', () => {
    const names = ['pi-kit', 'reporting-api', 'notes', 'website', 'infra', 'mobile', 'docs', 'billing', 'search', 'ml'];
    expect(new Set(names.map(tileHue)).size).toBeGreaterThanOrEqual(3);
  });

  it('is pinned for a few names, so a change of the hash is a deliberate one', () => {
    expect(['pi-kit', 'reporting-api', 'notes', 'website', 'mobile'].map(tileHue)).toEqual([
      'success',
      'primary',
      'secondary',
      'neutral',
      'info',
    ]);
  });

  it('the letter is the first letter or digit, upper case', () => {
    expect(tileLetter('pi-kit')).toBe('P');
    expect(tileLetter('  -reporting')).toBe('R');
    expect(tileLetter('3d-models')).toBe('3');
    expect(tileLetter('émile')).toBe('É');
    expect(tileLetter('---')).toBe('•');
  });
});

describe('summaryLine: the first that exists', () => {
  it('is the attendant’s summary when it has one, even for a thread that waits', () => {
    const t = thread('a', {
      lastLine: 'The last answer',
      messageCount: 4,
      state: idleState({ summary: 'Writing the wizard', activity: 'waiting', question: 'Proceed?' }),
    });
    expect(summaryLine(english, t)).toEqual({ kind: 'summary', text: 'Writing the wizard' });
  });

  it('then the question a waiting thread asks, with the suggested answer as its second chip', () => {
    const suggestion = answer('d1', 'Allow');
    const t = thread('a', {
      lastLine: 'The last answer',
      state: idleState({ activity: 'waiting', question: 'Proceed with the test?', suggestions: [suggestion] }),
    });
    expect(summaryLine(english, t)).toEqual({
      kind: 'question',
      question: 'Proceed with the test?',
      answer: suggestion,
    });
    expect(summaryLine(english, thread('b', { state: idleState({ activity: 'waiting', question: null }) }))).toEqual({
      kind: 'question',
      question: 'Needs an answer',
      answer: null,
    });
  });

  it('then the first line of pi’s last answer from the thread index', () => {
    expect(
      summaryLine(english, thread('a', { lastLine: '  Done. The summary groups by month.  ', messageCount: 6 })),
    ).toEqual({
      kind: 'last',
      text: 'Done. The summary groups by month.',
    });
  });

  it('else the number of messages, with forks and the archive mark', () => {
    expect(summaryLine(english, thread('a', { messageCount: 0 }))).toEqual({ kind: 'count', text: 'No messages yet' });
    expect(summaryLine(english, thread('a', { messageCount: 1 }))).toEqual({ kind: 'count', text: '1 message' });
    expect(summaryLine(english, thread('a', { messageCount: 4, forkCount: 2, archived: true }))).toEqual({
      kind: 'count',
      text: '4 messages, 2 forks, archived',
    });
    expect(summaryLine(english, thread('a', { messageCount: 4, lastLine: '   ' }))).toMatchObject({ kind: 'count' });
  });
});

describe('statusLine: the state in words and colour', () => {
  const line = (over: Parameters<typeof idleState>[0], options?: { looking?: boolean }) =>
    statusLine(english, thread('a', { state: idleState(over) }), options);

  it('names each state and gives it a tone', () => {
    expect(line({ activity: 'running' })).toEqual({ kind: 'running', label: 'Running', tone: 'run' });
    expect(line({ activity: 'waiting', question: 'Ok?' })).toEqual({
      kind: 'waiting',
      label: 'Waiting for you',
      tone: 'wait',
    });
    expect(line({ lastRun: 'finished', unread: true, unseen: true })).toEqual({
      kind: 'unread',
      label: 'Done, unread',
      tone: 'plain',
    });
    expect(line({ lastRun: 'aborted' })).toEqual({ kind: 'aborted', label: 'Aborted', tone: 'muted' });
    expect(line({ lastRun: 'error' })).toEqual({ kind: 'error', label: 'The last run failed', tone: 'err' });
    expect(line({})).toEqual({ kind: 'idle', label: 'Idle', tone: 'muted' });
  });

  it('says the context in warning from 70 % and in error from 90 %', () => {
    expect(line({ context: 69 }).kind).toBe('idle');
    expect(line({ context: 73 })).toEqual({ kind: 'context', label: '73 % context', tone: 'warn' });
    expect(line({ context: 89 })).toMatchObject({ kind: 'context', tone: 'warn' });
    expect(line({ context: 90 })).toEqual({ kind: 'context-high', label: '90 % context', tone: 'err' });
    expect(line({ context: 96 })).toEqual({ kind: 'context-high', label: '96 % context', tone: 'err' });
  });

  it('shows the strongest state; a nearly full context ranks over a run, a filling one under it', () => {
    expect(line({ activity: 'waiting', context: 96, lastRun: 'error' }).kind).toBe('waiting');
    expect(line({ activity: 'running', context: 96 }).kind).toBe('context-high');
    expect(line({ activity: 'running', context: 73 }).kind).toBe('running');
    expect(line({ lastRun: 'aborted', context: 73 }).kind).toBe('aborted');
  });

  it('the thread you are looking at has no news, but its failure stays', () => {
    expect(line({ lastRun: 'finished', unread: true }, { looking: true }).kind).toBe('idle');
    expect(line({ lastRun: 'error' }, { looking: true }).kind).toBe('error');
  });

  it('the command-line mark is not a state: it sits beside one, and a context under a run gets a small gauge', () => {
    const cli = thread('a', { state: idleState({ cli: true }) });
    expect(statusLine(english, cli).kind).toBe('idle');
    expect(hasCliMark(cli)).toBe(true);
    expect(hasCliMark(cli, { looking: true })).toBe(false);
    const running = thread('b', { state: idleState({ activity: 'running', context: 73 }) });
    expect(gaugeBesideStatus(running, statusLine(english, running))).toBe('warn');
    const full = thread('c', { state: idleState({ context: 96 }) });
    expect(gaugeBesideStatus(full, statusLine(english, full))).toBeUndefined();
    expect(
      gaugeBesideStatus(thread('d', { state: idleState({ activity: 'running', context: 20 }) }), {
        kind: 'running',
        label: 'Running',
        tone: 'run',
      }),
    ).toBeUndefined();
  });
});

describe('collapsedTags', () => {
  it('keeps "N running" and "N waiting" for a folded project, and nothing for zero', () => {
    expect(collapsedTags(english, { running: 2, waiting: 1 })).toEqual([
      { kind: 'running', text: '2 running' },
      { kind: 'waiting', text: '1 waiting' },
    ]);
    expect(collapsedTags(english, { running: 0, waiting: 3 })).toEqual([{ kind: 'waiting', text: '3 waiting' }]);
    expect(collapsedTags(english, { running: 0, waiting: 0 })).toEqual([]);
  });
});

describe('answerChips', () => {
  const waiting = (
    dialog: NonNullable<ReturnType<typeof idleState>['dialog']> | null,
    suggestions: ThreadSuggestion[] = [],
  ) => thread('w', { state: idleState({ activity: 'waiting', question: 'Which runner?', dialog, suggestions }) });

  it('a confirm dialog is Allow and Deny, answering as the approval block does', () => {
    const chips = answerChips(english, waiting({ id: 'd1', method: 'confirm' }));
    expect(chips.map((c) => c.label)).toEqual(['Allow', 'Deny']);
    expect(chips[0].action).toEqual({ type: 'dialog', dialogId: 'd1', payload: { confirmed: true } });
    expect(chips[1].action).toEqual({ type: 'dialog', dialogId: 'd1', payload: { confirmed: false } });
    expect(chips.some((c) => c.suggested)).toBe(false);
  });

  it('the attendant’s suggested answer comes first and is marked', () => {
    const chips = answerChips(english, waiting({ id: 'd1', method: 'confirm' }, [answer('d1', 'Deny')]));
    expect(chips.map((c) => [c.label, c.suggested])).toEqual([
      ['Deny', true],
      ['Allow', false],
    ]);
  });

  it('localizes confirmation labels while keeping the suggested answer and boolean action intact', () => {
    const chips = answerChips(german, waiting({ id: 'd1', method: 'confirm' }, [answer('d1', 'Deny')]));
    expect(chips.map((chip) => [chip.key, chip.label, chip.suggested])).toEqual([
      ['Deny', 'Ablehnen', true],
      ['Allow', 'Zulassen', false],
    ]);
    expect(chips[0].action).toEqual({ type: 'dialog', dialogId: 'd1', payload: { confirmed: false } });
  });

  it('a select dialog offers its options (the first few, then Open), the suggested one first', () => {
    const chips = answerChips(
      english,
      waiting({ id: 'd2', method: 'select', options: ['Vitest', 'Jest'] }, [answer('d2', 'Jest')]),
    );
    expect(chips.map((c) => c.label)).toEqual(['Jest', 'Vitest']);
    expect(chips[0].action).toEqual({ type: 'dialog', dialogId: 'd2', payload: { value: 'Jest' } });
    const many = answerChips(english, waiting({ id: 'd3', method: 'select', options: ['a', 'b', 'c', 'd', 'e'] }));
    expect(many.map((c) => c.label)).toEqual(['a', 'b', 'c', 'Open']);
    expect(many.at(-1)?.action).toEqual({ type: 'open' });
  });

  it('a suggestion of another dialog is not offered', () => {
    expect(
      answerChips(english, waiting({ id: 'd1', method: 'confirm' }, [answer('other', 'Deny')])).map((c) => [
        c.label,
        c.suggested,
      ]),
    ).toEqual([
      ['Allow', false],
      ['Deny', false],
    ]);
  });

  it('an input dialog or a question in prose offers the suggested answer when there is one, and Open otherwise', () => {
    expect(answerChips(english, waiting({ id: 'd4', method: 'input' })).map((c) => c.label)).toEqual(['Open']);
    expect(answerChips(english, waiting(null)).map((c) => c.label)).toEqual(['Open']);
    const typed = answerChips(english, waiting({ id: 'd4', method: 'input' }, [answer('d4', 'main')]));
    expect(typed.map((c) => c.label)).toEqual(['main', 'Open']);
    expect(typed[0].action).toEqual({ type: 'dialog', dialogId: 'd4', payload: { value: 'main' } });
    // Without a dialog there is nothing to resume: the chip opens the thread.
    expect(answerChips(english, waiting(null, [answer('x', 'Vitest')]))[0]).toMatchObject({
      label: 'Vitest',
      suggested: true,
      action: { type: 'open' },
    });
  });
});

describe('needsYou: the threads waiting on the person', () => {
  const ws = (cwd: string, name: string) => ({ cwd, name });
  const waits = (id: string, updatedAt: number, over: Parameters<typeof thread>[1] = {}) =>
    thread(id, {
      updatedAt,
      state: idleState({
        activity: 'waiting',
        question: `Question ${id}?`,
        dialog: { id: `d-${id}`, method: 'confirm' },
      }),
      ...over,
    });

  it('lists the waiting threads of every project, newest first, with the project name and the question', () => {
    const result = needsYou(english, [
      { workspace: ws('/a', 'pi-kit'), threads: [waits('t1', 100), thread('idle', { updatedAt: 999 })] },
      { workspace: ws('/b', 'reporting-api'), threads: [waits('t2', 300), waits('t3', 200)] },
    ]);
    expect(result.items.map((i) => [i.thread.id, i.project.name, i.question])).toEqual([
      ['t2', 'reporting-api', 'Question t2?'],
      ['t3', 'reporting-api', 'Question t3?'],
      ['t1', 'pi-kit', 'Question t1?'],
    ]);
    expect(result.items[0].chips.map((c) => c.label)).toEqual(['Allow', 'Deny']);
    expect(result.total).toBe(3);
  });

  it('is empty when nothing waits, and does not ask about an archived thread', () => {
    expect(
      needsYou(english, [
        { workspace: ws('/a', 'pi-kit'), threads: [thread('x'), waits('t1', 1, { archived: true })] },
      ]),
    ).toEqual({ items: [], total: 0 });
    expect(needsYou(english, [])).toEqual({ items: [], total: 0 });
  });
});
