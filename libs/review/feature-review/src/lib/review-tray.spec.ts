import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ReviewComment } from '@pi-kit/protocol';
import { ChatStore } from '@pi-kit/chat/api';
import { ChangesStore } from '@pi-kit/review/data';
import { ReviewTray } from './review-tray';

const comment = (id: string, file: string, line: number): ReviewComment =>
  ({ id, file, line, side: 'new', snippet: '', text: `note ${id}` }) as ReviewComment;

describe('ReviewTray', () => {
  const ordered = signal<ReviewComment[]>([]);
  const running = signal(false);
  const review = {
    ordered,
    commentCount: () => ordered().length,
    commentFiles: () => new Set(ordered().map((c) => c.file)).size,
    sendLabel: () => (ordered().length === 0 ? 'Send comments to pi' : `Send ${ordered().length} comments to pi`),
    select: vi.fn(),
    discardAll: vi.fn(),
    send: vi.fn(),
  };

  const render = () => {
    const fixture = TestBed.createComponent(ReviewTray);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    ordered.set([]);
    running.set(false);
    review.select.mockClear();
    review.discardAll.mockClear();
    review.send.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChangesStore, useValue: review },
        { provide: ChatStore, useValue: { running } },
      ],
    });
  });

  it('invites the first comment and keeps Send and Discard off', () => {
    const el = render();
    expect(el.textContent).toContain('No comments yet');
    const buttons = Array.from(el.querySelectorAll('button'));
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('shows one chip per comment and sends the batch', () => {
    ordered.set([comment('a', 'src/app.ts', 12), comment('b', 'README.md', 3)]);
    const el = render();
    expect(el.textContent).toContain('2 comments pending');
    expect(el.textContent).toContain('on 2 files');
    const chips = Array.from(el.querySelectorAll<HTMLButtonElement>('.chip'));
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['app.ts:12', 'README.md:3']);
    chips[0].click();
    expect(review.select).toHaveBeenCalledWith('src/app.ts');
    el.querySelector<HTMLButtonElement>('.btn-primary')?.click();
    expect(review.send).toHaveBeenCalled();
    Array.from(el.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Discard all'))
      ?.click();
    expect(review.discardAll).toHaveBeenCalled();
  });

  it('waits for pi to finish before it sends', () => {
    ordered.set([comment('a', 'a.ts', 1)]);
    running.set(true);
    const el = render();
    expect(el.querySelector<HTMLButtonElement>('.btn-primary')?.disabled).toBe(true);
    expect(el.textContent).toContain('pi is running. Send once it has finished.');
  });
});
