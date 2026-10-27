import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type QueueItem, queueItems } from '@pi-kit/protocol';
import { ChatStore } from '@pi-kit/chat/data';
import { QueueBar } from './queue-bar';

describe('QueueBar', () => {
  const rows = signal<QueueItem[]>([]);
  const chat = {
    queueRows: rows,
    steerQueued: vi.fn(),
    removeQueued: vi.fn(),
    editQueued: vi.fn(),
    mergeQueued: vi.fn(),
    clearQueued: vi.fn(),
  };

  const render = () => {
    const fixture = TestBed.createComponent(QueueBar);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, fixture };
  };
  /** The button with this text or aria-label inside `scope`, or undefined when there is none. */
  const find = (label: string, scope: ParentNode) =>
    Array.from(scope.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    );
  const button = (label: string, scope: ParentNode): HTMLButtonElement => {
    const found = find(label, scope);
    if (!found) throw new Error(`No button ${label}`);
    return found;
  };
  const part = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`No element matches ${selector}`);
    return found;
  };

  beforeEach(() => {
    rows.set([]);
    for (const fn of Object.values(chat)) if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ChatStore, useValue: chat }] });
  });

  it('draws nothing for an empty queue', () => {
    expect(render().el.querySelector('.pk-queue')).toBeNull();
  });

  it('lists steering first, then follow-ups, with the count and the delivery rule', () => {
    rows.set(queueItems({ steering: ['a', 'b'], followUp: ['c'] }));
    const { el } = render();
    expect(el.querySelector('.count')?.textContent).toBe('3');
    expect(el.querySelector('.head')?.textContent).toContain('steer goes after this turn, follow-up after the run');
    expect(
      Array.from(el.querySelectorAll('.item')).map(
        (i) => `${i.getAttribute('data-kind')}:${i.querySelector('.txt')?.textContent?.trim()}`,
      ),
    ).toEqual(['steer:a', 'steer:b', 'followUp:c']);
    expect(Array.from(el.querySelectorAll('.kind')).map((k) => k.textContent?.trim())).toEqual([
      'steer',
      'steer',
      'follow-up',
    ]);
  });

  it('offers Steer now on a follow-up only, and Edit and Remove on every row', () => {
    rows.set(queueItems({ steering: ['a'], followUp: ['c'] }));
    const { el } = render();
    const [steer, followUp] = Array.from(el.querySelectorAll('.item'));
    expect(find('Steer now', part(steer, '.acts'))).toBeUndefined();
    expect(find('Steer now', part(followUp, '.acts'))).toBeDefined();
    button('Steer now', part(followUp, '.acts')).click();
    expect(chat.steerQueued).toHaveBeenCalledWith({ kind: 'followUp', index: 0, text: 'c' });
    button('Edit', part(steer, '.acts')).click();
    expect(chat.editQueued).toHaveBeenCalledWith({ kind: 'steer', index: 0, text: 'a' });
    button('Remove', followUp).click();
    expect(chat.removeQueued).toHaveBeenCalledWith({ kind: 'followUp', index: 0, text: 'c' });
  });

  it('Merge and Clear all; Merge waits for a second message', () => {
    rows.set(queueItems({ steering: ['a'], followUp: [] }));
    const { el } = render();
    expect(button('Merge', el).disabled).toBe(true);
    rows.set(queueItems({ steering: ['a', 'b'], followUp: [] }));
    TestBed.tick();
    button('Merge', el).click();
    expect(chat.mergeQueued).toHaveBeenCalled();
    button('Clear all', el).click();
    expect(chat.clearQueued).toHaveBeenCalled();
  });

  it('a tap on a row opens its actions (the phone layout), a second tap closes them', () => {
    rows.set(queueItems({ steering: ['a'], followUp: [] }));
    const { el } = render();
    const item = part(el, '.item');
    part(item, '.txt').click();
    TestBed.tick();
    expect(item.classList.contains('open')).toBe(true);
    part(item, '.txt').click();
    TestBed.tick();
    expect(item.classList.contains('open')).toBe(false);
  });
});
