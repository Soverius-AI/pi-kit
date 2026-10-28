import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ChangedFile, ChangesList } from '@pi-kit/protocol';
import { UiStore } from '@pi-kit/data-access';
import { ChangesStore } from '@pi-kit/review/data';
import { ChangesPanel } from './changes-panel';

const file = (path: string, status: 'M' | 'A' | 'D' = 'M', added = 1, removed = 0): ChangedFile =>
  ({ path, status, added, removed, binary: false }) as ChangedFile;

describe('ChangesPanel', () => {
  const files = signal<ChangedFile[]>([]);
  const selectedId = signal<string | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const source = signal<'thread' | 'worktree' | 'outcome'>('thread');
  const hasOutcome = signal(false);
  const review = {
    files,
    selectedId,
    error,
    source,
    hasOutcome,
    editable: () => source() !== 'outcome',
    list: () => ({ files: files(), git: true }) as unknown as ChangesList,
    notGit: () => false,
    loading: () => false,
    busy: () => undefined,
    mode: () => 'chat',
    counts: () => new Map<string, number>([['src/a.ts', 2]]),
    groups: () => {
      const dirs = new Map<string, ChangedFile[]>();
      for (const f of files())
        dirs.set(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '', [
          ...(dirs.get(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') ?? []),
          f,
        ]);
      return [...dirs].map(([dir, list]) => ({ dir, files: list }));
    },
    open: vi.fn(),
    setSource: vi.fn(),
    revert: vi.fn(async () => true),
    stageAll: vi.fn(),
  };

  const render = () => {
    const fixture = TestBed.createComponent(ChangesPanel);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };
  const button = (el: HTMLElement, text: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);

  beforeEach(() => {
    files.set([file('src/a.ts', 'M', 3, 1), file('src/b.ts', 'A'), file('README.md', 'D', 0, 5)]);
    selectedId.set(undefined);
    error.set(undefined);
    source.set('thread');
    hasOutcome.set(false);
    for (const fn of [review.open, review.setSource, review.revert, review.stageAll]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ChangesStore, useValue: review }] });
  });

  it('lists the changed files by folder with their counts and pending comments', () => {
    const { el } = render();
    expect(el.textContent).toContain('3 files');
    expect(Array.from(el.querySelectorAll('.pk-section')).map((s) => s.textContent?.trim())).toEqual([
      'src',
      'Top level',
    ]);
    const row = el.querySelector('a.pk-file[title="src/a.ts"]');
    expect(row?.textContent).toContain('+3');
    expect(row?.textContent).toContain('−1');
    expect(row?.querySelector('.badge')?.textContent?.trim()).toBe('2');
  });

  it('a click opens the file in review mode and the source switch asks for the other source', () => {
    const { el } = render();
    el.querySelector<HTMLAnchorElement>('a.pk-file[title="src/b.ts"]')?.click();
    expect(review.open).toHaveBeenCalledWith('src/b.ts');
    button(el, 'Working tree')?.click();
    expect(review.setSource).toHaveBeenCalledWith('worktree');
  });

  it('has an Outcome toggle that is off until the thread has an outcome', () => {
    const { fixture, el } = render();
    const toggle = button(el, 'Outcome');
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.title).toMatch(/no outcome yet/);
    toggle?.click();
    expect(review.setSource).not.toHaveBeenCalled();
    hasOutcome.set(true);
    fixture.detectChanges();
    expect(button(el, 'Outcome')?.disabled).toBe(false);
    button(el, 'Outcome')?.click();
    expect(review.setSource).toHaveBeenCalledWith('outcome');
  });

  it('cannot revert or stage on the Outcome source', () => {
    hasOutcome.set(true);
    source.set('outcome');
    selectedId.set('src/a.ts');
    const { el } = render();
    expect(button(el, 'Revert file')?.disabled).toBe(true);
    expect(button(el, 'Stage all')?.disabled).toBe(true);
    expect(button(el, 'Outcome')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('reverting asks first, names the file, and only a confirmation reverts', async () => {
    selectedId.set('src/a.ts');
    const { fixture, el } = render();
    button(el, 'Revert file')?.click();
    fixture.detectChanges();
    expect(el.querySelector('dialog')?.textContent).toContain('Revert a.ts?');
    expect(el.querySelector('dialog')?.textContent).toContain('Your 2 pending comments on it will be dropped.');
    button(el, 'Cancel')?.click();
    fixture.detectChanges();
    expect(el.querySelector('dialog')).toBeNull();
    expect(review.revert).not.toHaveBeenCalled();

    button(el, 'Revert file')?.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('dialog .btn-error')?.click();
    await fixture.whenStable();
    expect(review.revert).toHaveBeenCalledWith('src/a.ts');
  });

  it('closing the panel goes through the UI store', () => {
    const { el } = render();
    const ui = TestBed.inject(UiStore);
    ui.setPanel('changes');
    el.querySelector<HTMLButtonElement>('[aria-label="Close the changes panel"]')?.click();
    expect(ui.panel()).toBeNull();
  });

  it('says so when the changes cannot be loaded', () => {
    error.set('not a repository');
    const { el } = render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('not a repository');
  });
});
