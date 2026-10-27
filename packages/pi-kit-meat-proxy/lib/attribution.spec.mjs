import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAttributionPrompt, buildLabelEntries, examplesText, loadPrompt, parseAttribution, parseInput } from './attribution.mjs';
import { splitDiff } from './hunks.mjs';
import { buildLedger } from './ledger.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/thread.json', import.meta.url), 'utf8'));
const hunks = splitDiff(readFileSync(new URL('./fixtures/outcome.diff', import.meta.url), 'utf8'));
const ledger = buildLedger({ transcript: fixture.transcript, baselines: fixture.baselines, outsideEdits: fixture.outsideEdits, hunks });

describe('the attribution prompt', () => {
  it('has a system part with the four labels and a user part, from prompts/attribute.md', () => {
    const { system, user } = loadPrompt();
    for (const label of ['specified', 'corrected', 'autonomous', 'manual']) expect(system).toContain(`- ${label}:`);
    expect(user).toContain('{{ledger}}');
    expect(user).toContain('{{hunks}}');
  });

  it('shows the model the ledger and the hunks it has to label, and keeps the hand-edited file out of the list', () => {
    const { user, plan } = buildAttributionPrompt({ ledger, hunks });
    expect(plan.shown.map((s) => s.key)).toEqual(['h1', 'h2', 'h3']);
    expect(plan.byRule.map((h) => h.file)).toEqual(['notes/gamma.md', 'notes/gamma.md']);
    expect(user).toContain('## What the person did, message by message');
    expect(user).toContain('h1 | notes/alpha.md | @@ -0,0 +1,3 @@ | +3 -0');
    expect(user).toContain('  +# Alpha');
    expect(user).toContain('h3 | src/map.ts | @@ -1,3 +1,4 @@ | +2 -1');
    expect(user).toContain('2 hunks in files only the person changed by hand are labelled manual without you');
    expect(user).not.toContain('notes/gamma.md | @@');
    expect(user).not.toContain('{{');
  });

  it('puts the person’s earlier corrections in as examples', () => {
    const stored = { corrections: { 'src/map.ts@1:1': { file: 'src/map.ts', header: '@@ -1,3 +1,4 @@', excerpt: ['+  if (row.total < 0) throw'], was: 'autonomous', label: 'specified' } } };
    expect(buildAttributionPrompt({ ledger, hunks, stored }).user).toContain('src/map.ts @@ -1,3 +1,4 @@ (+ if (row.total < 0) throw): the model said autonomous, the person says specified');
    expect(examplesText(null)).toBe('');
  });

  it('cuts a long hunk body', () => {
    const long = { id: 'x@1:1', file: 'x', header: '@@ -1 +1,40 @@', section: '', oldStart: 1, newStart: 1, added: 40, removed: 0, lines: Array.from({ length: 40 }, (_, i) => `+line ${i}`) };
    const { user } = buildAttributionPrompt({ ledger: { ...ledger, handOnly: [] }, hunks: [long] });
    expect(user).toContain('… 16 more changed lines');
  });
});

describe('parseInput', () => {
  it.each([
    ['prompt 1', { input: 'first-prompt', turn: 1 }],
    ['message 3', { input: 'follow-up', turn: 3 }],
    ['review 3', { input: 'review', turn: 3 }],
    ['hand', { input: 'hand' }],
    ['dialog', { input: 'dialog' }],
    ['chip 2', { input: 'chip', turn: 2 }],
    ['none', { input: 'none' }],
    ['', { input: 'none' }],
    ['something else', { input: 'none' }],
  ])('%s', (text, expected) => expect(parseInput(text)).toEqual(expected));
});

describe('parseAttribution: the model’s answer', () => {
  const keys = ['h1', 'h2', 'h3'];

  it('reads one line per hunk', () => {
    const parsed = parseAttribution('h1 | specified | prompt 1 | asked for this file by name\nh2 | specified | prompt 1 | same\nh3 | corrected | prompt 2 | “No, instead” asked for it', keys);
    expect(parsed.missing).toEqual([]);
    expect(parsed.labels.get('h1')).toEqual({ label: 'specified', input: 'first-prompt', turn: 1, reason: 'asked for this file by name' });
    expect(parsed.labels.get('h3')).toMatchObject({ label: 'corrected', input: 'follow-up', turn: 2 });
  });

  it('forgives bullets, bold marks, a code fence, colons and capitals', () => {
    const parsed = parseAttribution('```\n- **h1** | Specified | prompt 1 | ok\n2. h2: autonomous | none | extra\n`h3` | MANUAL | hand\n```', keys);
    expect([...parsed.labels].map(([k, v]) => `${k}:${v.label}`)).toEqual(['h1:specified', 'h2:autonomous', 'h3:manual']);
  });

  it('reports hunks it skipped and lines about hunks that are not on the list', () => {
    const parsed = parseAttribution('h1 | specified | prompt 1 | ok\nh9 | specified | prompt 1 | which?\nsome chatter', keys);
    expect(parsed.missing).toEqual(['h2', 'h3']);
    expect(parsed.unknown).toEqual(['h9 | specified | prompt 1 | which?']);
  });

  it('a line without a label is skipped, an empty answer labels nothing', () => {
    expect(parseAttribution('h1 | probably | prompt 1', keys).labels.size).toBe(0);
    expect(parseAttribution('', keys).missing).toEqual(keys);
  });
});

describe('buildLabelEntries: every hunk of the outcome gets a label and an input', () => {
  const { plan } = buildAttributionPrompt({ ledger, hunks });
  const reply = 'h1 | specified | prompt 1 | named alpha.md\nh2 | specified | prompt 1 | named beta.md\nh3 | corrected | prompt 2 | the correction asked for it';
  const entries = buildLabelEntries({ plan, parsed: parseAttribution(reply, ['h1', 'h2', 'h3']), ledger, hunks });

  it('covers all hunks in diff order', () => {
    expect(entries.map((e) => e.id)).toEqual(hunks.map((h) => h.id));
  });

  it('the model’s labels carry their input and reason', () => {
    expect(entries[0]).toMatchObject({ file: 'notes/alpha.md', label: 'specified', input: 'first-prompt', turn: 1, trace: 'named alpha.md', by: 'model', lines: 3 });
    expect(entries[4]).toMatchObject({ file: 'src/map.ts', label: 'corrected', input: 'follow-up', turn: 2, by: 'model' });
  });

  it('a file only the hand changed is manual by rule', () => {
    expect(entries[2]).toMatchObject({ label: 'manual', input: 'hand', by: 'ledger' });
    expect(entries[2].trace).toContain('3 changes seen');
    expect(entries[3]).toMatchObject({ label: 'manual', by: 'ledger' });
  });

  it('autonomous never traces to an input, manual always to the hand, and a steered label always to something', () => {
    const odd = buildLabelEntries({
      plan,
      parsed: parseAttribution('h1 | autonomous | prompt 1 | x\nh2 | manual | prompt 1 | y\nh3 | specified | none | z', ['h1', 'h2', 'h3']),
      ledger,
      hunks,
    });
    expect(odd[0]).toMatchObject({ label: 'autonomous', input: 'none' });
    expect(odd[1]).toMatchObject({ label: 'manual', input: 'hand' });
    // src/map.ts is named by message 2 in the ledger, so a "specified" with no input traces there.
    expect(odd[4]).toMatchObject({ label: 'specified', input: 'follow-up', turn: 2 });
  });

  it('corrected with no input falls back to the review comment on the file', () => {
    const reviewed = buildLabelEntries({ plan, parsed: parseAttribution('h1 | corrected | none | x\nh2 | specified | prompt 1 | y\nh3 | specified | prompt 1 | z', ['h1', 'h2', 'h3']), ledger, hunks });
    expect(reviewed[0]).toMatchObject({ label: 'corrected', input: 'review', turn: 3 });
  });

  it('every entry has an excerpt for the examples to come', () => {
    expect(entries[0].excerpt).toEqual(['+# Alpha', '+The first note.', '+It has two lines of text.']);
  });
});
