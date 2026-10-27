import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { ThreadTranscriptSchema } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_STEPS, isCheckCommand, reduceTranscript, targetOf } from './transcript';

const chain = (...messages: unknown[]): PiSessionEntry[] =>
  messages.map((message, i) => ({ type: 'message', id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}`, timestamp: '2026-10-17T10:00:00.000Z', message }));

const user = (text: string) => ({ role: 'user', content: text });
const call = (callId: string, name: string, args: Record<string, unknown>) => ({ role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', id: callId, name, arguments: args }] });
const result = (callId: string, toolName: string, text: string, isError = false) => ({ role: 'toolResult', toolCallId: callId, toolName, content: [{ type: 'text', text }], isError });

const base = { threadId: 't1', title: 'Add a migration', cwd: '/p', leafId: null };

describe('reduceTranscript', () => {
  const entries = chain(
    user('Add a migration for the invoices table, with a test'),
    call('c1', 'read', { path: 'db/schema.sql' }),
    result('c1', 'read', 'CREATE TABLE users (id INTEGER);'),
    call('c2', 'write', { path: 'db/0003.sql', content: 'CREATE TABLE invoices (id INTEGER);' }),
    result('c2', 'write', 'wrote 1 line'),
    call('c3', 'bash', { command: 'npm test' }),
    result('c3', 'bash', 'FAIL migration 0003 missing from the index\nexit code 1', true),
    call('c4', 'edit', { path: 'db/index.ts', edits: [] }),
    result('c4', 'edit', 'edited'),
    call('c5', 'bash', { command: 'npm test' }),
    result('c5', 'bash', 'all green'),
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    user('Also run the linter'),
    call('c6', 'bash', { command: 'npx eslint .' }),
    result('c6', 'bash', 'clean'),
    call('c7', 'bash', { command: 'ls' }),
    result('c7', 'bash', 'a b'),
  );

  const transcript = reduceTranscript({ ...base, entries, outcome: { base: 'a'.repeat(40), head: 'b'.repeat(40), diff: 'diff --git a/db/0003.sql\n+CREATE TABLE invoices (id INTEGER);', changedLines: 12, commitMessage: 'Add the invoices table' } });

  it('keeps what the person asked, in order', () => {
    expect(transcript.prompts).toEqual(['Add a migration for the invoices table, with a test', 'Also run the linter']);
  });

  it('lists the tool calls with their target and how each ended', () => {
    expect(transcript.toolCalls).toBe(7);
    expect(transcript.steps).toEqual([
      { n: 1, tool: 'read', target: 'db/schema.sql', outcome: 'ok' },
      { n: 2, tool: 'write', target: 'db/0003.sql', outcome: 'ok' },
      { n: 3, tool: 'bash', target: 'npm test', outcome: 'error' },
      { n: 4, tool: 'edit', target: 'db/index.ts', outcome: 'ok' },
      { n: 5, tool: 'bash', target: 'npm test', outcome: 'ok' },
      { n: 6, tool: 'bash', target: 'npx eslint .', outcome: 'ok' },
      { n: 7, tool: 'bash', target: 'ls', outcome: 'ok' },
    ]);
  });

  it('records the error and the step that recovered it', () => {
    expect(transcript.errors).toEqual([{ step: 3, tool: 'bash', target: 'npm test', message: 'FAIL migration 0003 missing from the index exit code 1', recovered: true, recoveredBy: 5 }]);
  });

  it('records the checks that were run and whether they passed (a plain ls is no check)', () => {
    expect(transcript.checks).toEqual([
      { step: 3, command: 'npm test', passed: false },
      { step: 5, command: 'npm test', passed: true },
      { step: 6, command: 'npx eslint .', passed: true },
    ]);
  });

  it('carries the outcome’s diff, size and commit message', () => {
    expect(transcript).toMatchObject({ changedLines: 12, commitMessage: 'Add the invoices table', base: 'a'.repeat(40), head: 'b'.repeat(40), truncated: false });
    expect(transcript.diff).toContain('+CREATE TABLE invoices');
  });

  it('matches the plugin API’s schema', () => {
    expect(ThreadTranscriptSchema.safeParse(transcript).success).toBe(true);
  });

  it('marks an error that never recovered', () => {
    const t = reduceTranscript({ ...base, entries: chain(user('x'), call('c1', 'bash', { command: 'make build' }), result('c1', 'bash', 'boom', true)) });
    expect(t.errors).toEqual([{ step: 1, tool: 'bash', target: 'make build', message: 'boom', recovered: false, recoveredBy: null }]);
    expect(t.diff).toBeNull();
    expect(t.changedLines).toBe(0);
  });

  it('follows the active branch only', () => {
    const forked: PiSessionEntry[] = [
      ...chain(user('first'), call('c1', 'read', { path: 'a' }), result('c1', 'read', 'x')),
      { type: 'message', id: 'side', parentId: 'm0', message: call('s1', 'write', { path: 'abandoned' }) },
    ];
    const t = reduceTranscript({ ...base, entries: forked, leafId: 'm2' });
    expect(t.steps.map((s) => s.target)).toEqual(['a']);
  });

  it('counts a command the person ran with ! as a step, and as a check when it is one', () => {
    const t = reduceTranscript({ ...base, entries: chain(user('x'), { role: 'bashExecution', command: 'pytest -q', output: 'ok', exitCode: 0 }, { role: 'bashExecution', command: 'vitest run', output: 'no', exitCode: 1 }) });
    expect(t.checks).toEqual([
      { step: 1, command: 'pytest -q', passed: true },
      { step: 2, command: 'vitest run', passed: false },
    ]);
  });

  it('cuts a long thread in the middle and says so, but keeps every error and check', () => {
    const many: unknown[] = [user('long')];
    for (let i = 1; i <= MAX_STEPS + 50; i++) {
      many.push(call(`c${i}`, 'read', { path: `f${i}.ts` }), result(`c${i}`, 'read', 'x'));
    }
    many.push(call('cx', 'bash', { command: 'npm test' }), result('cx', 'bash', 'ok'));
    const t = reduceTranscript({ ...base, entries: chain(...many) });
    expect(t.truncated).toBe(true);
    expect(t.toolCalls).toBe(MAX_STEPS + 51);
    expect(t.steps.length).toBeLessThan(MAX_STEPS + 51);
    expect(t.steps.some((s) => s.target === 'npm test')).toBe(true);
    expect(t.checks).toHaveLength(1);
  });
});

describe('redaction runs before anything leaves', () => {
  const key = `sk-${'a1B2c3D4'.repeat(5)}`;
  const github = `ghp_${'x9Y8z7'.repeat(7)}`;
  const entries = chain(
    user(`Deploy with my key ${key} please`),
    call('c1', 'bash', { command: `curl -H "Authorization: Bearer ${'t'.repeat(30)}" https://api.example.test` }),
    result('c1', 'bash', `401 for ${github}`, true),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2', 'bash', 'ok'),
  );
  const t = reduceTranscript({
    ...base,
    entries,
    outcome: { base: null, head: null, diff: `+API_KEY=${key}\n+other`, changedLines: 2, commitMessage: `Use ${github}` },
  });

  it('masks keys in the prompts, targets, error messages, diff and commit message', () => {
    const everything = JSON.stringify(t);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain(github);
    expect(everything).not.toContain('t'.repeat(30));
    expect(t.prompts[0]).toMatch(/\[redacted openai key …/);
    expect(t.diff).toMatch(/\[redacted openai key …/);
    expect(t.commitMessage).toMatch(/\[redacted github token …/);
    expect(t.errors[0].message).toMatch(/\[redacted github token …/);
    expect(t.steps[0].target).toMatch(/\[redacted bearer token …/);
  });

  it('counts the places it masked', () => {
    expect(t.redactions).toBeGreaterThanOrEqual(5);
  });

  it('applies the user’s own patterns too', () => {
    const custom = reduceTranscript({ ...base, entries: chain(user('the ticket is ACME-12345-SECRET')), patterns: [{ kind: 'ticket', pattern: /ACME-\d+-SECRET/g }] });
    expect(custom.prompts[0]).toMatch(/\[redacted ticket/);
    expect(custom.redactions).toBe(1);
  });
});

describe('helpers', () => {
  it('finds the target of a call by the usual argument names', () => {
    expect(targetOf({ path: 'a.ts' })).toBe('a.ts');
    expect(targetOf({ file_path: 'b.ts', other: 1 })).toBe('b.ts');
    expect(targetOf({ command: 'ls   -la\n' })).toBe('ls -la');
    expect(targetOf({ pattern: 'TODO' })).toBe('TODO');
    expect(targetOf({})).toBeNull();
    expect(targetOf(undefined)).toBeNull();
    expect(targetOf({ command: 'x'.repeat(500) })?.length).toBe(200);
  });

  it('knows a check command from any other', () => {
    for (const yes of ['npm test', 'npm run lint', 'pnpm build', 'npx vitest run', 'pytest -x', 'cargo test', 'go test ./...', 'make check', 'tsc --noEmit', 'node --test e2e']) expect(isCheckCommand(yes), yes).toBe(true);
    for (const no of ['ls', 'cat package.json', 'git status', 'npm install', 'echo hello']) expect(isCheckCommand(no), no).toBe(false);
  });
});

describe('turns: what the Meat Proxy Score’s ledger reads', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, seconds)).toISOString();
  const timed = (items: { at: number; entry: Record<string, unknown> }[]): PiSessionEntry[] =>
    items.map(({ at: seconds, entry }, i) => ({ id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, timestamp: at(seconds), ...entry }) as PiSessionEntry);
  const msg = (seconds: number, message: unknown) => ({ at: seconds, entry: { type: 'message', message } });
  const custom = (seconds: number, customType: string, data: unknown) => ({ at: seconds, entry: { type: 'custom', customType, data } });
  const said = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

  const entries = timed([
    msg(0, user('Add notes/alpha.md and notes/beta.md')),
    msg(1, call('c1', 'write', { path: 'notes/alpha.md', content: 'a' })),
    msg(2, result('c1', 'write', 'ok')),
    msg(3, call('c2', 'write', { path: '/p/notes/beta.md', content: 'b' })),
    msg(4, result('c2', 'write', 'ok')),
    msg(5, said('I added alpha and beta. I also reformatted the README.')),
    // the person reads for two minutes, then corrects
    msg(125, user('No, not that: leave the README alone')),
    msg(126, call('c3', 'edit', { path: 'README.md', edits: [] })),
    msg(127, result('c3', 'edit', 'ok')),
    msg(128, said('Reverted the README.')),
    // a review batch with a skill chip on the next message: the custom entries come first
    custom(200, 'pi-kit.review', { comments: [{ id: 'k1', file: 'notes/alpha.md', side: 'new', line: 2, snippet: 'The first note.', text: 'Say FIRST here' }] }),
    msg(200, user('Review comments:\n- notes/alpha.md:2 Say FIRST here')),
    msg(201, call('c4', 'bash', { command: 'npm test' })),
    msg(202, result('c4', 'bash', 'green')),
    msg(203, said('Done.')),
    // a follow-up that pi picked up from the queue the moment it finished
    custom(203, 'pi-kit.skills', { chips: [{ kind: 'skill', name: 'pdf-tools', pinned: false }], text: 'also use the skill' }),
    msg(203, user('<skill name="pdf-tools">long expanded instructions</skill>\n\nalso use the skill')),
  ]);

  const t = reduceTranscript({ ...base, entries, folder: '/p', answers: [{ at: Date.parse(at(126)), method: 'confirm', title: 'Allow edit?', status: 'resolved', confirmed: true }] });
  const turns = t.turns ?? [];

  it('has one turn per user message, numbered, with the tool calls that followed', () => {
    expect(turns.map((x) => [x.n, x.toolCalls])).toEqual([[1, 2], [2, 1], [3, 1], [4, 0]]);
    expect(t.prompts).toHaveLength(4);
  });

  it('knows when each was sent and how long the person took', () => {
    expect(turns[0]).toMatchObject({ at: Date.parse(at(0)), gapMs: null, queued: false });
    expect(turns[1]).toMatchObject({ gapMs: 120_000, queued: false });
    expect(turns[2]).toMatchObject({ gapMs: 72_000, queued: false });
  });

  it('a message pi took up the moment the turn before ended is queued: nobody waited for it', () => {
    expect(turns[3]).toMatchObject({ gapMs: 0, queued: true });
  });

  it('names the files pi edited or wrote while working on each message, inside the folder', () => {
    expect(turns[0]?.files).toEqual(['notes/alpha.md', 'notes/beta.md']);
    expect(turns[1]?.files).toEqual(['README.md']);
    expect(turns[2]?.files).toEqual([]);
  });

  it('carries what pi said before each message, cut to its end', () => {
    expect(turns[0]?.previous).toBeNull();
    expect(turns[1]?.previous).toBe('I added alpha and beta. I also reformatted the README.');
    expect(turns[2]?.previous).toBe('Reverted the README.');
  });

  it('attaches the review comments and the chips of the entries written right before a message, and shows the sentence as it was typed', () => {
    expect(turns[2]?.review).toEqual([{ file: 'notes/alpha.md', side: 'new', line: 2, text: 'Say FIRST here', snippet: 'The first note.' }]);
    expect(turns[0]?.review).toBeNull();
    expect(turns[3]?.chips).toEqual([{ kind: 'skill', name: 'pdf-tools' }]);
    expect(turns[3]?.text).toBe('also use the skill');
  });

  it('puts a dialog the person answered on the message pi was working on', () => {
    expect(turns[1]?.answers).toEqual([{ method: 'confirm', title: 'Allow edit?', status: 'resolved', confirmed: true }]);
    expect(turns[0]?.answers).toEqual([]);
  });

  it('is redacted like everything else, and a turn’s text is not counted as a second masked place', () => {
    const key = `sk-${'q7Zr3Kd9'.repeat(5)}`;
    const secret = reduceTranscript({
      ...base,
      folder: '/p',
      entries: timed([
        msg(0, user(`My key is ${key}`)),
        custom(10, 'pi-kit.review', { comments: [{ id: 'k', file: 'a.ts', side: 'new', line: 1, snippet: 'x', text: `use ${key}` }] }),
        msg(10, user('see the comment')),
      ]),
      answers: [{ at: Date.parse(at(5)), method: 'input', title: 'Token?', status: 'resolved', value: key }],
    });
    expect(JSON.stringify(secret)).not.toContain(key);
    expect(secret.turns?.[0]?.text).toMatch(/\[redacted/);
    expect(secret.turns?.[0]?.answers[0]?.value).toMatch(/\[redacted/);
    expect(secret.turns?.[1]?.review?.[0]?.text).toMatch(/\[redacted/);
    // the prompt, the answer and the review comment: three places, not four
    expect(secret.redactions).toBe(3);
  });

  it('matches the plugin API’s schema', () => {
    expect(ThreadTranscriptSchema.safeParse(t).success).toBe(true);
  });

  it('a session without timestamps still has its turns', () => {
    const plain = reduceTranscript({ ...base, entries: chain(user('one'), call('c1', 'read', { path: 'a' }), result('c1', 'read', 'x'), user('two')) });
    expect(plain.turns?.map((x) => [x.n, x.gapMs === null || typeof x.gapMs === 'number'])).toEqual([[1, true], [2, true]]);
  });
});
