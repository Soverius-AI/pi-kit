import { describe, expect, it, vi } from 'vitest';
import { browserStep } from './browser-step';

describe('bounded browser native step', () => {
  it('does not start work after cancellation', async () => {
    const work = vi.fn(async () => 1);
    const controller = new AbortController();
    controller.abort();
    await expect(browserStep(work, 'timeout', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(work).not.toHaveBeenCalled();
  });

  it('releases a permanently pending step on timeout and retires its owner only once', async () => {
    const interrupted = vi.fn();
    const controller = new AbortController();
    await expect(browserStep(() => new Promise(() => { /* native work never settles */ }), 'Native step stalled', {
      timeoutMs: 10, signal: controller.signal, interrupted,
    })).rejects.toMatchObject({ code: 'timeout', message: 'Native step stalled' });
    controller.abort();
    expect(interrupted).toHaveBeenCalledOnce();
  });

  it('cleans up timers and cancellation listeners after success', async () => {
    const controller = new AbortController();
    const interrupted = vi.fn();
    expect(await browserStep(async () => 42, 'timeout', { signal: controller.signal, interrupted })).toBe(42);
    controller.abort();
    expect(interrupted).not.toHaveBeenCalled();
  });

  it('observes late failures after cancellation without reviving the step', async () => {
    let fail!: (error: Error) => void;
    const controller = new AbortController();
    const result = browserStep(() => new Promise((_, reject) => { fail = reject; }), 'timeout', { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    fail(new Error('late native failure'));
    await Promise.resolve();
  });
});
