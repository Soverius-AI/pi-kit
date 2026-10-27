import { TestBed } from '@angular/core/testing';
import { DEFAULT_RENDERER_POLICY, RENDERER_POLICY } from './renderer-policy';
import { ToastStore } from './toast.store';

describe('ToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
  });
  afterEach(() => vi.useRealTimers());

  it('shows a toast and removes it after its stay', () => {
    const toasts = TestBed.inject(ToastStore);
    toasts.show('info', 'Saved');
    expect(toasts.items().map((t) => t.text)).toEqual(['Saved']);
    vi.advanceTimersByTime(5999);
    expect(toasts.items()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(toasts.items()).toHaveLength(0);
  });

  it('a short stay is honoured', () => {
    const toasts = TestBed.inject(ToastStore);
    toasts.show('success', 'GPT-5', 1500);
    vi.advanceTimersByTime(1501);
    expect(toasts.items()).toHaveLength(0);
  });

  it('keeps the newest four', () => {
    const toasts = TestBed.inject(ToastStore);
    for (const n of [1, 2, 3, 4, 5]) toasts.show('info', `t${n}`);
    expect(toasts.items().map((t) => t.text)).toEqual(['t2', 't3', 't4', 't5']);
  });

  it('dismiss removes one by id', () => {
    const toasts = TestBed.inject(ToastStore);
    toasts.show('error', 'a');
    toasts.show('error', 'b');
    toasts.dismiss(toasts.items()[0].id);
    expect(toasts.items().map((t) => t.text)).toEqual(['b']);
  });
  it('honours injected duration and capacity, including a single-toast stack', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: RENDERER_POLICY, useValue: { ...DEFAULT_RENDERER_POLICY, toastMs: 25, maxToasts: 1 } }],
    });
    const toasts = TestBed.inject(ToastStore);
    toasts.show('info', 'first');
    toasts.show('info', 'second');
    expect(toasts.items().map((t) => t.text)).toEqual(['second']);
    vi.advanceTimersByTime(24);
    expect(toasts.items()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.items()).toHaveLength(0);
  });
});
