import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBranch } from './branch';
import { contextPercent, lastAssistantLine, lastContext } from './thread-context';
import { computeThreadState, questionHead, type StateFacts } from './thread-state';

const facts = (over: Partial<StateFacts> = {}): StateFacts => ({
  running: false,
  dialogs: [],
  lastRun: undefined,
  contextPct: null,
  seenAt: 1000,
  origin: 'app',
  fileMtime: 5000,
  logMtime: 5000,
  summary: null,
  suggestions: [],
  ...over,
});
const dialog = (title: string) => ({ id: 'd1', request: { method: 'confirm' as const, title } });

describe('computeThreadState', () => {
  it('a background agent\'s question for the user makes the thread wait like a dialog, after pi\'s own', () => {
    const question = { id: 'agent-question:7:q1', agentId: '7', request: { method: 'select' as const, title: 'Change greet to add punctuation?', options: ['Keep as is', 'Change it'], agent: 'reviewer' } };
    const state = computeThreadState(facts({ agentQuestions: [question] }));
    expect(state).toMatchObject({ activity: 'waiting', question: 'Change greet to add punctuation?', dialog: { id: 'agent-question:7:q1', method: 'select', options: ['Keep as is', 'Change it'] }, agentQuestions: [question] });
    expect(computeThreadState(facts({ running: true, agentQuestions: [question] })).activity).toBe('waiting');
    expect(computeThreadState(facts({ dialogs: [dialog('Allow bash?')], agentQuestions: [question] })).question).toBe('Allow bash?');
    expect(computeThreadState(facts({ agentQuestions: [] }))).not.toHaveProperty('agentQuestions');
  });

  it('names the run that holds the lock while the thread runs, so a client that follows it needs no second replay', () => {
    expect(computeThreadState(facts({ running: true, lastRun: { runId: 'turn-1', status: 'running', endedAt: null } })).run).toBe('turn-1');
    expect(computeThreadState(facts({ lastRun: { runId: 'turn-1', status: 'finished', endedAt: 5 } }))).not.toHaveProperty('run');
  });

  it('an untouched thread is idle and says nothing', () => {
    expect(computeThreadState(facts())).toEqual({ activity: 'idle', question: null, dialog: null, context: null, lastRun: null, unread: false, unseen: false, cli: false, summary: null, suggestions: [], outcome: null, draft: null });
  });

  it('carries the outcome of the thread as the badge the sidebar draws', () => {
    const outcome = { kind: 'merged' as const, head: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', at: 5000 };
    expect(computeThreadState(facts({ outcome })).outcome).toEqual(outcome);
    expect(computeThreadState(facts({ outcome: null })).outcome).toBeNull();
    // It does not change the activity or the unread dot.
    expect(computeThreadState(facts({ outcome }))).toMatchObject({ activity: 'idle', unread: false, cli: false });
  });

  it('names the first pending dialog so the sidebar can answer it: its id, its kind and a select’s options', () => {
    expect(computeThreadState(facts({ dialogs: [dialog('Proceed?')] })).dialog).toEqual({ id: 'd1', method: 'confirm' });
    const select = { id: 'd2', request: { method: 'select' as const, title: 'Which runner?', options: ['Vitest', 'Jest'] } };
    expect(computeThreadState(facts({ dialogs: [select, dialog('Later')] })).dialog).toEqual({ id: 'd2', method: 'select', options: ['Vitest', 'Jest'] });
    // A question in prose has no dialog to resume.
    expect(computeThreadState(facts({ prose: 'Vitest or Jest?' })).dialog).toBeNull();
  });

  it('running while the lock row says so', () => {
    expect(computeThreadState(facts({ running: true, lastRun: { status: 'running', endedAt: null } }))).toMatchObject({ activity: 'running', lastRun: null, unread: false });
  });

  it('an answer that ends in a question is waiting too, with that question, unless a run is on', () => {
    const state = computeThreadState(facts({ prose: 'Vitest, Jest or Mocha?' }));
    expect(state.activity).toBe('waiting');
    expect(state.question).toBe('Vitest, Jest or Mocha?');
    expect(computeThreadState(facts({ prose: 'Vitest, Jest or Mocha?', running: true })).activity).toBe('running');
    expect(computeThreadState(facts({ prose: '  ' })).activity).toBe('idle');
  });

  it('waiting wins over running, with the first words of the question', () => {
    const state = computeThreadState(facts({ running: true, dialogs: [dialog('Delete the scratch file in the project folder, including its backups?')] }));
    expect(state.activity).toBe('waiting');
    expect(state.question).toBe('Delete the scratch file in the project folder,…');
  });

  it('a run that finished after the last look is unread; looking at it clears it', () => {
    const finished = { status: 'finished' as const, endedAt: 2000 };
    expect(computeThreadState(facts({ lastRun: finished, seenAt: 1000 })).unread).toBe(true);
    expect(computeThreadState(facts({ lastRun: finished, seenAt: 2500 })).unread).toBe(false);
  });

  it('a stopped or failed run shows its own badge and is never "unread"', () => {
    expect(computeThreadState(facts({ lastRun: { status: 'aborted', endedAt: 2000 } }))).toMatchObject({ lastRun: 'aborted', unread: false, unseen: true });
    expect(computeThreadState(facts({ lastRun: { status: 'error', endedAt: 2000 }, seenAt: 3000 }))).toMatchObject({ lastRun: 'error', unread: false, unseen: false });
  });

  it('cli: a session the pi command line made and nobody opened, or a file that changed behind the app', () => {
    expect(computeThreadState(facts({ origin: 'cli', seenAt: null })).cli).toBe(true);
    expect(computeThreadState(facts({ origin: 'cli', seenAt: 3000 })).cli).toBe(false);
    expect(computeThreadState(facts({ fileMtime: 9000, logMtime: 5000 })).cli).toBe(true);
    // looking at the thread after the file changed clears it, before the log has caught up
    expect(computeThreadState(facts({ fileMtime: 9000, logMtime: 5000, seenAt: 9500 })).cli).toBe(false);
    // a run's own writes land a moment after the log's mtime was taken
    expect(computeThreadState(facts({ fileMtime: 5400, logMtime: 5000 })).cli).toBe(false);
    // no log yet: nothing to compare with
    expect(computeThreadState(facts({ fileMtime: 9000, logMtime: null })).cli).toBe(false);
  });

  it('cli is not shown on a thread that runs, waits, or has an unread result (those say more)', () => {
    expect(computeThreadState(facts({ fileMtime: 9000, logMtime: 5000, running: true })).cli).toBe(false);
    expect(computeThreadState(facts({ fileMtime: 9000, logMtime: 5000, dialogs: [dialog('Ok?')] })).cli).toBe(false);
    expect(computeThreadState(facts({ fileMtime: 9000, logMtime: 5000, lastRun: { status: 'finished', endedAt: 4000 }, seenAt: 100 })).cli).toBe(false);
  });

  it('carries the context share, the summary and the suggestions through', () => {
    const suggestions = [{ id: 1, kind: 'answer' as const, target: 'd1', text: 'Allow' }];
    expect(computeThreadState(facts({ contextPct: 96, summary: 'Adding tests', suggestions }))).toMatchObject({ context: 96, summary: 'Adding tests', suggestions });
  });
});

describe('questionHead', () => {
  it('keeps a short question whole', () => {
    expect(questionHead({ method: 'confirm', title: 'Proceed with the test?' })).toBe('Proceed with the test?');
  });

  it('cuts at eight words, and at 60 characters on a word boundary', () => {
    expect(questionHead({ method: 'input', title: 'one two three four five six seven eight nine ten' })).toBe('one two three four five six seven eight…');
    const long = questionHead({ method: 'input', title: 'Supercalifragilisticexpialidocious '.repeat(4).trim() });
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
  });

  it('falls back to the message, then to a plain phrase', () => {
    expect(questionHead({ method: 'confirm', title: ' ', message: 'Really?' })).toBe('Really?');
    expect(questionHead({ method: 'confirm', title: '' })).toBe('Needs an answer');
  });
});

describe('lastContext', () => {
  const assistant = (id: string, parentId: string | null, totalTokens: number, extra: Record<string, unknown> = {}): PiSessionEntry => ({
    type: 'message',
    id,
    parentId,
    message: { role: 'assistant', provider: 'llama-swap', model: 'gemma', usage: { input: totalTokens - 10, output: 10, totalTokens }, stopReason: 'stop', ...extra },
  });
  const user = (id: string, parentId: string | null): PiSessionEntry => ({ type: 'message', id, parentId, message: { role: 'user', content: 'x' } });

  it('is the last response of the branch, counted as pi counts it', () => {
    const entries = [user('u1', null), assistant('a1', 'u1', 1000), user('u2', 'a1'), assistant('a2', 'u2', 190_700)];
    expect(lastContext(entries, 'a2')).toEqual({ tokens: 190_700, provider: 'llama-swap', model: 'gemma' });
    expect(contextPercent(190_700, 262_144)).toBe(73);
  });

  it('follows the branch the leaf is on, not the newest entry of the file', () => {
    const entries = [user('u1', null), assistant('a1', 'u1', 1000), assistant('other', 'u1', 200_000)];
    expect(lastContext(entries, 'a1')?.tokens).toBe(1000);
  });

  it('skips a stopped or failed request and sums the parts when there is no total', () => {
    const entries = [user('u1', null), assistant('a1', 'u1', 500), user('u2', 'a1'), assistant('a2', 'u2', 0, { stopReason: 'aborted', usage: { input: 9, output: 0 } })];
    expect(lastContext(entries, 'a2')?.tokens).toBe(500);
    const parts: PiSessionEntry[] = [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', model: 'm', usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 } } }];
    expect(lastContext(parts, 'a')?.tokens).toBe(155);
  });

  it('is unknown after a compaction and before any response', () => {
    const entries = [user('u1', null), assistant('a1', 'u1', 900), { type: 'compaction', id: 'c1', parentId: 'a1' } as PiSessionEntry];
    expect(lastContext(entries, 'c1')).toBeNull();
    expect(lastContext([user('u1', null)], 'u1')).toBeNull();
    expect(contextPercent(10, undefined)).toBeNull();
  });
});

describe('lastAssistantLine', () => {
  const user = (id: string, parentId: string | null): PiSessionEntry => ({ type: 'message', id, parentId, message: { role: 'user', content: 'x' } });
  const reply = (id: string, parentId: string | null, content: unknown, extra: Record<string, unknown> = {}): PiSessionEntry => ({ type: 'message', id, parentId, message: { role: 'assistant', content, ...extra } });

  it('is the first line of the last answer on the branch, without markdown marks', () => {
    const entries = [user('u1', null), reply('a1', 'u1', [{ type: 'text', text: '## Done\nAll **three** tests pass.' }])];
    expect(lastAssistantLine(entries, 'a1')).toBe('Done');
    expect(lastAssistantLine([user('u1', null), reply('a1', 'u1', 'The summary groups by month.\nSecond line.')], 'a1')).toBe('The summary groups by month.');
  });

  it('skips fenced code, blank lines and a response that only called tools, and follows the leaf', () => {
    const entries = [
      user('u1', null),
      reply('a1', 'u1', [{ type: 'text', text: 'Earlier answer' }]),
      user('u2', 'a1'),
      reply('a2', 'u2', [{ type: 'text', text: '\n```ts\nconst x = 1;\n```\n\n- First: the fix' }]),
      reply('tool', 'a2', [{ type: 'toolCall', name: 'bash' }]),
      reply('other', 'u1', [{ type: 'text', text: 'Another branch' }]),
    ];
    expect(lastAssistantLine(entries, 'tool')).toBe('First: the fix');
    expect(lastAssistantLine(entries, 'other')).toBe('Another branch');
  });

  it('ignores a stopped or failed response, cuts a long line and is null without an answer', () => {
    const entries = [user('u1', null), reply('a1', 'u1', 'Good', {}), user('u2', 'a1'), reply('a2', 'u2', 'Half an ans', { stopReason: 'aborted' })];
    expect(lastAssistantLine(entries, 'a2')).toBe('Good');
    const long = lastAssistantLine([reply('a', null, `${'word '.repeat(60)}end`)], 'a') as string;
    expect(long.length).toBeLessThanOrEqual(141);
    expect(long.endsWith('…')).toBe(true);
    expect(lastAssistantLine([user('u1', null)], 'u1')).toBeNull();
  });
});

describe('currentBranch', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'pk-branch-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the branch from HEAD, also from a folder inside the repository', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/sidebar\n');
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    expect(currentBranch(dir)).toBe('feature/sidebar');
    expect(currentBranch(join(dir, 'packages', 'a'))).toBe('feature/sidebar');
  });

  it('shows the short commit when HEAD is detached', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(currentBranch(dir)).toBe('0123456');
  });

  it('follows the pointer file of a linked working tree', () => {
    const real = join(dir, 'main', '.git', 'worktrees', 'wt');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/wt-branch\n');
    mkdirSync(join(dir, 'wt'));
    writeFileSync(join(dir, 'wt', '.git'), `gitdir: ${real}\n`);
    expect(currentBranch(join(dir, 'wt'))).toBe('wt-branch');
  });

  it('is null outside a repository', () => {
    expect(currentBranch(dir)).toBeNull();
    expect(currentBranch(join(dir, 'missing'))).toBeNull();
  });
});
