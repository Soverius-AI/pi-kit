import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitDiff } from './hunks.mjs';
import { buildLedger, correctionOf, ledgerToText, specificityOf } from './ledger.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/thread.json', import.meta.url), 'utf8'));
const hunks = splitDiff(readFileSync(new URL('./fixtures/outcome.diff', import.meta.url), 'utf8'));

describe('specificityOf: how concrete a message is', () => {
  it('a message that names nothing is vague', () => {
    expect(specificityOf('make it better and faster please')).toMatchObject({ level: 'vague', kinds: 0, files: [], lines: [], commands: [], code: false });
  });

  it('names files by path and by extension, but not a version number or a link', () => {
    const s = specificityOf('Edit src/lib/map.ts and README.md, bump to 1.2.3, see https://example.com/a');
    expect(s.files).toEqual(['src/lib/map.ts', 'README.md']);
  });

  it('knows a file by the name the repository has for it', () => {
    expect(specificityOf('change the alpha.md note', ['notes/alpha.md']).files).toContain('notes/alpha.md');
    expect(specificityOf('change the walpha.mdx note', ['notes/alpha.md']).files).not.toContain('notes/alpha.md');
  });

  it('finds line numbers in the usual ways', () => {
    expect(specificityOf('fix line 42, lines 10-20, L7 and src/a.ts:15').lines).toEqual(expect.arrayContaining(['line 42', 'lines 10-20', 'L7', ':15']));
  });

  it('finds commands in backticks and after a dollar sign, and code in fences and calls', () => {
    const s = specificityOf('Run `npm run build` then\n$ git status\nand call `mapRow(row)` like:\n```ts\nconst x = 1;\n```');
    expect(s.commands).toEqual(['npm run build', 'git status']);
    expect(s.code).toBe(true);
  });

  it('three or more kinds make a message precise, one or two pointed', () => {
    expect(specificityOf('In src/map.ts line 3 run `npm test`').level).toBe('precise');
    expect(specificityOf('In src/map.ts add a check').level).toBe('pointed');
  });
});

describe('correctionOf: a small rule set', () => {
  it.each([
    ['No, not that one.', 'negation'],
    ['Not that, the other file', 'negation'],
    ['please undo the last change', 'undo'],
    ['Revert the README edit', 'undo'],
    ['Go back to the old name', 'undo'],
    ['Use a map instead of the loop', 'instead'],
    ['That is wrong, the test still fails', 'instead'],
    ['why did you touch the config?', 'instead'],
  ])('%s -> %s', (text, signal) => {
    expect(correctionOf(text, { first: false }).signals).toContain(signal);
  });

  it('quoting pi’s own words back is a correction', () => {
    const c = correctionOf('You said "I also changed the README" but I never asked for that', { previous: 'I added the notes. I also changed the README.' });
    expect(c.signals).toContain('quotes-pi');
  });

  it('review comments are corrections; the first message corrects nothing', () => {
    expect(correctionOf('see comments', { reviewComments: 2 })).toEqual({ is: true, signals: ['review'] });
    expect(correctionOf('No, instead do it differently', { first: true }).is).toBe(false);
  });

  it('plain instructions and words that only contain a rule word are not corrections', () => {
    for (const text of ['Add a note about nodes', 'Now run the tests', 'know your limits, see notes.md', 'Also add a header']) expect(correctionOf(text).is).toBe(false);
  });
});

describe('buildLedger over the recorded thread', () => {
  const ledger = buildLedger({ transcript: fixture.transcript, baselines: fixture.baselines, outsideEdits: fixture.outsideEdits, hunks });

  it('classifies the messages: first, follow-up, queued', () => {
    expect(ledger.messages.map((m) => m.kind)).toEqual(['first', 'follow-up', 'follow-up', 'queued']);
  });

  it('measures specificity per message against the files of the outcome', () => {
    expect(ledger.messages[0].specificity.files).toEqual(expect.arrayContaining(['notes/alpha.md', 'notes/beta.md']));
    expect(ledger.messages[1].specificity.files).toContain('src/map.ts');
    expect(ledger.messages[1].specificity.level).toBe('pointed');
    expect(ledger.messages[3].specificity.commands).toEqual(['npm test']);
  });

  it('finds the correction in message 2 and the review comment of message 3, and none elsewhere', () => {
    expect(ledger.messages.map((m) => m.correction.is)).toEqual([false, true, true, false]);
    expect(ledger.messages[1].correction.signals).toEqual(expect.arrayContaining(['negation', 'instead']));
    expect(ledger.messages[2].correction.signals).toEqual(['review']);
  });

  it('totals what the person did', () => {
    expect(ledger.totals).toMatchObject({ messages: 4, corrections: 2, reviewBatches: 1, reviewComments: 1, dialogAnswers: 1, chips: 1, unattendedTurns: 1, toolCalls: 9, handEditedFiles: 1, handEditedInOutcome: 1 });
    expect(ledger.totals.toolCallsPerMessage).toBe(2.3);
    // The person's time between turns counts the turns they waited for, not the queued one.
    expect(ledger.totals.waitMs).toBe(180_000);
    expect(ledger.totals.medianGapMs).toBe(90_000);
  });

  it('a file that only the hand changed is the person’s whole; a file both changed is not', () => {
    expect(ledger.handOnly).toEqual(['notes/gamma.md']);
    const both = buildLedger({ transcript: fixture.transcript, baselines: [...fixture.baselines, { path: 'notes/gamma.md', turn: 3 }], outsideEdits: fixture.outsideEdits, hunks });
    expect(both.handOnly).toEqual([]);
  });

  it('keeps per file what led to it', () => {
    const alpha = ledger.files.find((f) => f.path === 'notes/alpha.md');
    expect(alpha).toMatchObject({ inDiff: true, named: [1, 3], reviewed: [{ n: 3, line: 2, endLine: null }], piTouched: { turn: 1, edits: 2 }, byHand: null });
  });

  it('works on a transcript from before turns existed, from the prompts alone', () => {
    const old = buildLedger({ transcript: { prompts: ['Fix src/map.ts line 2'], toolCalls: 3 }, hunks });
    expect(old.messages).toHaveLength(1);
    expect(old.messages[0].kind).toBe('first');
    expect(old.totals.toolCalls).toBe(3);
  });

  it('reads as text the model (and the person) can follow', () => {
    const text = ledgerToText(ledger);
    expect(text).toContain('1. [first prompt; pointed; names notes/alpha.md');
    expect(text).toContain('2. [follow-up; pointed; names src/map.ts, line 2;');
    expect(text).toContain('correction (negation, instead)');
    expect(text).toContain('review comment on notes/alpha.md:2');
    expect(text).toContain('dialog answer (confirm: Allow bash?): allow');
    expect(text).toContain('queued message (pi picked it up unattended)');
    expect(text).toContain('- notes/gamma.md: pi never edited it; changed by hand 3 times outside pi');
    expect(text).toContain('4 messages, 2 corrections, 1 review comments');
  });
});
