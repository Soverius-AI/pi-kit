import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreThread } from './pipeline.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/thread.json', import.meta.url), 'utf8'));
const diff = readFileSync(new URL('./fixtures/outcome.diff', import.meta.url), 'utf8');
const outcome = { kind: 'committed', base: 'a'.repeat(40), head: 'b'.repeat(40) };

/** A host that answers from the fixture and records what it was asked. */
function host(overrides = {}) {
  const calls = { run: [], annotate: [] };
  return {
    calls,
    outcome: async () => ({ ok: true, outcome, diff, annotations: { hunkLabels: null, scores: null } }),
    transcript: async () => ({ ok: true, transcript: fixture.transcript }),
    baselines: async () => ({ ok: true, files: fixture.baselines }),
    outsideEdits: async () => ({ ok: true, edits: fixture.outsideEdits }),
    run: async (prompt) => {
      calls.run.push(prompt);
      return { ok: true, model: 'fake/canned', text: 'h1 | specified | prompt 1 | named\nh2 | specified | prompt 1 | named\nh3 | corrected | prompt 2 | correction' };
    },
    annotate: async (body) => {
      calls.annotate.push(body);
      return { ok: true };
    },
    ...overrides,
  };
}

function coverageDiff(count, lines) {
  const paths = Array.from({ length: count }, (_, index) => `coverage-${index}.txt`);
  const fullDiff = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, () => `-${'old'.repeat(50)}\n+${'new'.repeat(50)}\n`).join('')}`).join('');
  return { paths, fullDiff };
}
const offeredHunks = (prompt) => [...prompt.user.matchAll(/^(h\d+) \| (coverage-\d+\.txt) \|/gm)];
const labelsFor = (shown) => shown.map((match) => `${match[1]} | specified | prompt 1 | named`).join('\n');

describe('scoreThread', () => {
  it('reads the records, asks the model once, writes the labels and the scores back', async () => {
    const h = host();
    const result = await scoreThread(h);
    expect(result.ok).toBe(true);
    expect(h.calls.run).toHaveLength(1);
    expect(h.calls.annotate).toHaveLength(1);
    const saved = h.calls.annotate[0];
    expect(saved).toMatchObject({ base: outcome.base, head: outcome.head, model: 'fake/canned' });
    expect(saved.labels.map((l) => l.label)).toEqual(['specified', 'specified', 'manual', 'manual', 'corrected']);
    // 3 + 4 specified, 3 + 1 manual, 3 corrected of 14 changed lines (the binary file has none).
    expect(saved.scores).toMatchObject({ meat: 100, vibe: 0, hunks: 5, steered: 5, lines: 14 });
    expect(saved.scores.byInput).toEqual({ 'first-prompt': 2, hand: 2, 'follow-up': 1 });
    expect(result.scores.line).toBe('100 % steered: 5 of 5 hunks, 2 by the first prompt, 1 by later prompts, 2 by hand');
  });

  it('an autonomous hunk lowers the score by its lines', async () => {
    const h = host({ run: async () => ({ ok: true, model: 'm', text: 'h1 | specified | prompt 1 | a\nh2 | autonomous | none | b\nh3 | autonomous | none | c' }) });
    const result = await scoreThread(h);
    // steered: alpha 3 + the two hand hunks 3 + 1; autonomous: beta 4 and map.ts 3.
    expect(result.scores).toMatchObject({ meat: 50, steered: 3, hunks: 5, lines: 14 });
  });

  it('keeps the person’s corrections: the score is of the labels as they stand', async () => {
    const asked = [];
    const stored = { corrections: { 'notes/beta.md@0:1': { file: 'notes/beta.md', header: '@@ -0,0 +1,4 @@', label: 'specified', was: 'autonomous' } } };
    const h = host({
      outcome: async () => ({ ok: true, outcome, diff, annotations: { hunkLabels: stored } }),
      run: async (prompt) => {
        asked.push(prompt);
        return { ok: true, model: 'm', text: 'h1 | specified | prompt 1 | a\nh2 | autonomous | none | b\nh3 | autonomous | none | c' };
      },
    });
    const result = await scoreThread(h);
    expect(asked[0].user).toContain('the model said autonomous, the person says specified');
    expect(result.scores.steered).toBe(4);
    expect(result.labels.find((l) => l.file === 'notes/beta.md')).toMatchObject({ label: 'specified', by: 'person' });
    // What is written back is the model's own labels; the corrections stay in pi-kit's store.
    expect(h.calls.annotate[0].labels.find((l) => l.file === 'notes/beta.md').label).toBe('autonomous');
  });

  it('stops without a model call when the thread has no outcome', async () => {
    const h = host({ outcome: async () => ({ ok: true, outcome: null, diff: null }) });
    const result = await scoreThread(h);
    expect(result).toMatchObject({ ok: false, code: 'not-found' });
    expect(h.calls.run).toHaveLength(0);
  });

  it('stops without a model call when the diff has no text hunks', async () => {
    const h = host({ outcome: async () => ({ ok: true, outcome, diff: 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n' }) });
    expect(await scoreThread(h)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('passes the consent question on, and nothing is written', async () => {
    const h = host({ run: async () => ({ ok: false, code: 'consent', error: 'This sends the thread…', model: 'fake/canned' }) });
    expect(await scoreThread(h)).toMatchObject({ ok: false, code: 'consent', model: 'fake/canned' });
    expect(h.calls.annotate).toHaveLength(0);
  });

  it('an answer that labels nothing is a failure, not a score of zero', async () => {
    const h = host({ run: async () => ({ ok: true, model: 'm', text: 'I could not decide.' }) });
    expect(await scoreThread(h)).toMatchObject({ ok: false, code: 'failed' });
    expect(h.calls.annotate).toHaveLength(0);
  });

  it('does not publish a score when the model skips a hunk', async () => {
    const h = host({ run: async () => ({ ok: true, model: 'm', text: 'h1 | specified | prompt 1 | named' }) });
    expect(await scoreThread(h)).toMatchObject({ ok: false, code: 'failed' });
    expect(h.calls.annotate).toHaveLength(0);
  });

  it.each([
    { name: 'more than 150 hunks', count: 180, lines: 1 },
    { name: 'more than the old character budget', count: 40, lines: 24 },
  ])('asks for every hunk with $name instead of inventing default attribution', async ({ count, lines }) => {
    const { paths, fullDiff } = coverageDiff(count, lines);
    const offered = [];
    const progress = [];
    const h = host({
      outcome: async () => ({ ok: true, outcome, diff: fullDiff }),
      run: async (prompt, where) => {
        const shown = offeredHunks(prompt);
        offered.push(...shown.map((match) => match[2]));
        progress.push(where);
        return { ok: true, model: 'm', text: labelsFor(shown) };
      },
    });
    const result = await scoreThread(h);
    expect(offered).toEqual(paths);
    // The host hears which call of how many this is, in diff order, so a long scoring can be followed.
    expect(progress).toEqual(progress.map((_, index) => ({ batch: index + 1, batches: progress.length })));
    expect(result).toMatchObject({ ok: true, scores: { meat: 100, hunks: count } });
    expect(h.calls.annotate).toHaveLength(1);
    expect(h.calls.annotate[0].labels.map((label) => [label.file, label.by])).toEqual(paths.map((path) => [path, 'model']));
  });

  it('does not publish earlier successful batches when a later model request fails', async () => {
    const { fullDiff } = coverageDiff(40, 24);
    let requests = 0;
    const h = host({
      outcome: async () => ({ ok: true, outcome, diff: fullDiff }),
      run: async (prompt) => ++requests === 1
        ? { ok: true, model: 'm', text: labelsFor(offeredHunks(prompt)) }
        : { ok: false, code: 'cancelled', error: 'Stopped.' },
    });
    expect(await scoreThread(h)).toMatchObject({ ok: false, code: 'cancelled' });
    expect(h.calls.annotate).toHaveLength(0);
  });

  it('no model call at all when every hunk is the hand’s', async () => {
    const onlyHand = diff.split('diff --git a/notes/gamma.md')[1].split('diff --git a/src/map.ts')[0];
    const h = host({ outcome: async () => ({ ok: true, outcome, diff: `diff --git a/notes/gamma.md${onlyHand}` }) });
    const result = await scoreThread(h);
    expect(result.ok).toBe(true);
    expect(h.calls.run).toHaveLength(0);
    expect(result.scores.meat).toBe(100);
  });

  it('passes a failed lookup on', async () => {
    const h = host({ transcript: async () => ({ ok: false, code: 'not-found', error: 'There is no such thread.' }) });
    expect(await scoreThread(h)).toMatchObject({ ok: false, code: 'not-found' });
  });
});
