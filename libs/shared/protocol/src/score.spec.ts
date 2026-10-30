import { describe, expect, it } from 'vitest';
import { AnnotateRequestSchema, AttendantRunRequestSchema, BaselineFileSchema, OutcomeRequestSchema, PLUGIN_CHANNELS, PLUGIN_CHANNEL_LIST, TranscriptTurnSchema } from './plugins';
import { type HunkLabelEntry, HunkLabelEntrySchema, HunkLabelsStoreSchema, OutcomeScoresSchema, ProjectScoresSchema, RelabelHunkSchema, ThreadScoreBadgeSchema, effectiveHunks, hunkId } from './score';

const entry = (id: string, label: HunkLabelEntry['label'], over: Partial<HunkLabelEntry> = {}): HunkLabelEntry => ({ id, file: id.split('@')[0], header: '@@ -1 +1 @@', label, input: label === 'autonomous' ? 'none' : 'first-prompt', trace: 'because', lines: 3, by: 'model', ...over });

describe('hunk ids', () => {
  it('are the file and the two start lines of the header, as git prints them', () => {
    expect(hunkId('src/a.ts', 10, 12)).toBe('src/a.ts@10:12');
    expect(hunkId('notes/new.md', 0, 1)).toBe('notes/new.md@0:1');
  });
});

describe('effectiveHunks: the person’s corrections over the model’s labels', () => {
  const labels = [entry('a@1:1', 'autonomous'), entry('b@1:1', 'specified'), entry('c@1:1', 'corrected', { input: 'review' })];

  it('lets a correction replace the label, remembers what it was and says the person decided', () => {
    const [a, b, c] = effectiveHunks({ labels, corrections: { 'a@1:1': { label: 'specified', was: 'autonomous', file: 'a', header: '@@', at: 1 }, 'b@1:1': { label: 'autonomous', was: 'specified', file: 'b', header: '@@', at: 2 } } });
    expect(a).toMatchObject({ label: 'specified', was: 'autonomous', by: 'person', input: 'person' });
    expect(b).toMatchObject({ label: 'autonomous', was: 'specified', by: 'person', input: 'none' });
    expect(c).toBe(labels[2]);
  });

  it('keeps the input a steered hunk already had', () => {
    const [c] = effectiveHunks({ labels: [labels[2]], corrections: { 'c@1:1': { label: 'manual', was: 'corrected', file: 'c', header: '@@', at: 1 } } });
    expect(c).toMatchObject({ label: 'manual', input: 'review', by: 'person' });
  });
});

describe('the stored shapes', () => {
  it('a label is one of the four words, with an input from the list', () => {
    expect(HunkLabelEntrySchema.safeParse(entry('a@1:1', 'specified')).success).toBe(true);
    expect(HunkLabelEntrySchema.safeParse({ ...entry('a@1:1', 'specified'), label: 'great' }).success).toBe(false);
    expect(HunkLabelEntrySchema.safeParse({ ...entry('a@1:1', 'specified'), input: 'vibes' }).success).toBe(false);
  });

  it('the store carries the labels and the corrections; scores carry their inputs and the sentence', () => {
    expect(HunkLabelsStoreSchema.safeParse({ base: 'a', head: 'b', model: null, at: 1, labels: [entry('a@1:1', 'specified')], corrections: {} }).success).toBe(true);
    const scores = { meat: 62, vibe: 38, hunks: 23, steered: 14, lines: 100, steeredLines: 62, byLabel: { specified: { hunks: 1, lines: 1 }, corrected: { hunks: 1, lines: 1 }, autonomous: { hunks: 1, lines: 1 }, manual: { hunks: 1, lines: 1 } }, byInput: { 'first-prompt': 9 }, line: '62 % steered: 14 of 23 hunks, 9 by the first prompt' };
    expect(OutcomeScoresSchema.safeParse(scores).success).toBe(true);
    expect(OutcomeScoresSchema.safeParse({ ...scores, meat: 101 }).success).toBe(false);
  });

  it('the badge’s part says the package is installed by being there, and nulls say the thread was not scored', () => {
    expect(ThreadScoreBadgeSchema.safeParse({ meat: null, vibe: null, line: null, stale: false }).success).toBe(true);
    expect(ThreadScoreBadgeSchema.safeParse({ meat: 62, vibe: 38, line: 'x', stale: true }).success).toBe(true);
  });

  it('relabelling takes one of the four words or null; the distribution has ten bins', () => {
    expect(RelabelHunkSchema.safeParse({ hunk: 'a@1:1', label: null }).success).toBe(true);
    expect(RelabelHunkSchema.safeParse({ hunk: 'a@1:1', label: 'nope' }).success).toBe(false);
    expect(RelabelHunkSchema.safeParse({ hunk: 'a@1:1', label: 'manual', extra: 1 }).success).toBe(false);
    expect(ProjectScoresSchema.safeParse({ cwd: '/p', scored: 0, bins: Array(10).fill(0), mean: null, recent: [] }).success).toBe(true);
    expect(ProjectScoresSchema.safeParse({ cwd: '/p', scored: 0, bins: [0], mean: null, recent: [] }).success).toBe(false);
  });
});

describe('the events 10e added to the plugin API', () => {
  it('are on the list a session’s bus subscribes to', () => {
    for (const channel of ['pi-kit:thread:baselines', 'pi-kit:thread:annotate']) expect(PLUGIN_CHANNEL_LIST).toContain(channel);
    expect(PLUGIN_CHANNELS.annotate).toBe('pi-kit:thread:annotate');
  });

  it('annotate takes the outcome it describes, labels and scores, and nothing else', () => {
    expect(AnnotateRequestSchema.safeParse({ requestId: 'r', base: 'a', head: 'b', labels: [entry('a@1:1', 'specified')] }).success).toBe(true);
    expect(AnnotateRequestSchema.safeParse({ requestId: 'r', base: 'a', head: 'b', labels: null, scores: null }).success).toBe(true);
    expect(AnnotateRequestSchema.safeParse({ requestId: 'r', head: 'b' }).success).toBe(false);
    expect(AnnotateRequestSchema.safeParse({ requestId: 'r', base: 'a', head: 'b', sneaky: true }).success).toBe(false);
  });

  it('the outcome request asks for annotations, the attendant request for the task score', () => {
    expect(OutcomeRequestSchema.safeParse({ requestId: 'r', diff: true, annotations: true }).success).toBe(true);
    expect(AttendantRunRequestSchema.safeParse({ requestId: 'r', task: 'score', system: 's', user: 'u' }).success).toBe(true);
    expect(AttendantRunRequestSchema.safeParse({ requestId: 'r', task: 'wander', system: 's', user: 'u' }).success).toBe(false);
  });

  it('baselines carry paths and times, never content', () => {
    expect(BaselineFileSchema.safeParse({ path: 'a.ts', existed: false, at: 1, turn: 1, edits: 2 }).success).toBe(true);
  });

  it('a turn is a message with its timing, tool calls, chips, review comments and answers', () => {
    const turn = { n: 1, at: 1, text: 'hi', queued: false, gapMs: null, toolCalls: 0, files: [], chips: [{ kind: 'skill', name: 'x' }], review: null, answers: [{ method: 'confirm', title: 'Allow?', status: 'resolved', confirmed: true }], previous: null };
    expect(TranscriptTurnSchema.safeParse(turn).success).toBe(true);
    expect(TranscriptTurnSchema.safeParse({ ...turn, answers: [{ method: 'dance', title: '', status: 'resolved' }] }).success).toBe(false);
  });
});
