import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type DiffModel, type HunkLabelEntry, type OutcomeScoreView, hunksToModel } from '@pi-kit/protocol';
import { ChangesStore } from '@pi-kit/review/data';
import { CoordinationStore, ScoreStore } from '@pi-kit/threads/api';
import { ReviewView } from './review-view';

const entry = (file: string, over: Partial<HunkLabelEntry> = {}): HunkLabelEntry => ({
  id: `${file}@1:1`,
  file,
  header: '@@ -1,2 +1,2 @@',
  label: 'autonomous',
  input: 'none',
  trace: 'nobody asked for this',
  lines: 2,
  by: 'model',
  ...over,
});
const scoreView = (hunks: HunkLabelEntry[], over: Partial<OutcomeScoreView> = {}): OutcomeScoreView => ({
  scores: {
    meat: 62,
    vibe: 38,
    hunks: 3,
    steered: 2,
    lines: 10,
    steeredLines: 6,
    byLabel: {
      specified: { hunks: 1, lines: 3 },
      corrected: { hunks: 0, lines: 0 },
      autonomous: { hunks: 1, lines: 4 },
      manual: { hunks: 1, lines: 3 },
    },
    byInput: {},
    line: '62 % steered: 2 of 3 hunks, 1 by the first prompt, 1 by hand',
  },
  hunks,
  model: 'p/m',
  at: 1,
  stale: false,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  corrected: 0,
  ...over,
});

const model = (): DiffModel => ({
  path: 'notes/a.md',
  status: 'M',
  added: 1,
  removed: 1,
  binary: false,
  tooLarge: false,
  hunks: hunksToModel([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }]),
});

describe('ReviewView in the Outcome view', () => {
  const source = signal<'thread' | 'worktree' | 'outcome'>('outcome');
  const current = signal<OutcomeScoreView | undefined>(undefined);
  const review = {
    error: () => undefined,
    files: () => [{ path: 'notes/a.md', status: 'M', added: 1, removed: 1 }],
    list: () => ({ files: [] }),
    loading: () => false,
    source,
    model: () => model(),
    modelError: () => undefined,
    selectedFile: () => ({ path: 'notes/a.md' }),
    selectedId: () => 'notes/a.md',
    selectedComments: () => [],
    selectedIndex: () => 0,
    nextName: () => undefined,
    layout: () => 'unified',
    subtitle: () => 'in the outcome',
    threadId: () => 't1',
    save: vi.fn(),
    remove: vi.fn(),
    next: vi.fn(),
    openInEditor: vi.fn(),
  };
  const score = { current, relabel: vi.fn(async () => undefined) };

  const render = () => {
    const fixture = TestBed.createComponent(ReviewView);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    source.set('outcome');
    current.set(undefined);
    score.relabel.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChangesStore, useValue: review },
        { provide: CoordinationStore, useValue: { want: vi.fn(), leaseOf: () => undefined } },
        { provide: ScoreStore, useValue: score },
      ],
    });
  });

  it('shows plain hunks and no meter when the thread has no score (never scored, or the package is gone)', () => {
    const el = render();
    expect(el.querySelector('[data-testid="score-meter"]')).toBeNull();
    expect(el.querySelector('[data-testid="hunk-label"]')).toBeNull();
    expect(el.querySelector('[data-testid="hunk-relabel"]')).toBeNull();
    expect(el.querySelector('.ln.hunk')?.textContent).toContain('@@ -1,2 +1,2 @@');
  });

  it('shows the meter with the sentence and the label of the hunk with what it traces to', () => {
    current.set(
      scoreView([
        entry('notes/a.md', {
          label: 'corrected',
          input: 'review',
          trace: 'the review comment asked for this wording',
        }),
      ]),
    );
    const el = render();
    expect(el.querySelector('[data-testid="score-meat"]')?.textContent?.trim()).toBe('62 % steered');
    expect(el.querySelector('[data-testid="score-vibe"]')?.textContent?.trim()).toBe('38 % vibe');
    expect(el.querySelector('[data-testid="score-line"]')?.textContent?.trim()).toBe(
      '2 of 3 hunks, 1 by the first prompt, 1 by hand',
    );
    expect(el.querySelector('[data-testid="hunk-label"]')?.textContent?.trim()).toBe('corrected');
    expect(el.querySelector('[data-testid="hunk-label"]')?.getAttribute('data-label')).toBe('corrected');
    expect(el.querySelector('[data-testid="hunk-trace"]')?.textContent?.trim()).toBe(
      'the review comment asked for this wording',
    );
  });

  it('draws nothing of the score in the other sources', () => {
    current.set(scoreView([entry('notes/a.md')]));
    source.set('thread');
    const el = render();
    expect(el.querySelector('[data-testid="score-meter"]')).toBeNull();
    expect(el.querySelector('[data-testid="hunk-label"]')).toBeNull();
  });

  it('says the labels are out of date, and how many the person corrected', () => {
    current.set(
      scoreView([entry('notes/a.md', { by: 'person', label: 'specified', was: 'autonomous' })], {
        stale: true,
        corrected: 1,
      }),
    );
    const el = render();
    expect(el.querySelector('pk-score-meter')?.getAttribute('data-stale')).toBe('true');
    expect(el.querySelector('[data-testid="score-corrected"]')?.textContent?.trim()).toBe('1 label corrected by you');
    expect(el.querySelector('[data-testid="hunk-label"]')?.getAttribute('data-by')).toBe('person');
  });

  it('choosing another label in the hunk’s control relabels it; the person’s correction can be taken back', () => {
    current.set(scoreView([entry('notes/a.md')]));
    const el = render();
    const select = el.querySelector<HTMLSelectElement>('[data-testid="hunk-relabel"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'specified',
      'corrected',
      'autonomous',
      'manual',
    ]);
    expect(Array.from(select.options).find((o) => o.value === 'autonomous')?.disabled).toBe(true);
    select.value = 'specified';
    select.dispatchEvent(new Event('change'));
    expect(score.relabel).toHaveBeenCalledWith('t1', 'notes/a.md@1:1', 'specified');
    expect(select.value).toBe('');
  });

  it('a corrected hunk offers to go back to the model’s label', () => {
    current.set(scoreView([entry('notes/a.md', { by: 'person', label: 'specified', was: 'autonomous' })]));
    const el = render();
    const select = el.querySelector<HTMLSelectElement>('[data-testid="hunk-relabel"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('reset');
    select.value = 'reset';
    select.dispatchEvent(new Event('change'));
    expect(score.relabel).toHaveBeenCalledWith('t1', 'notes/a.md@1:1', null);
  });
});
