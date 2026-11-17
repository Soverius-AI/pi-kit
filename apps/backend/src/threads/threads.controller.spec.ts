import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { ThreadsEvent } from '@pi-kit/protocol';
import { ThreadsController } from './threads.controller';

describe('thread status stream', () => {
  it('buffers racing changes until after the asynchronous snapshot, then unsubscribes on close', async () => {
    let finish!: (states: Record<string, never>) => void;
    let listener!: (event: ThreadsEvent) => void;
    const leave = vi.fn();
    const status = {
      snapshot: () =>
        new Promise<Record<string, never>>((resolve) => {
          finish = resolve;
        }),
      subscribe: (next: typeof listener) => {
        listener = next;
        return leave;
      },
    };
    const res = Object.assign(new EventEmitter(), {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      writableEnded: false,
    });
    const controller = new ThreadsController({} as never, {} as never, status as never);
    const pending = controller.events(res as unknown as Response);
    listener({ type: 'list' });
    expect(res.write).not.toHaveBeenCalled();
    finish({});
    await pending;
    expect(res.write.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { type: 'snapshot', states: {} },
      { type: 'list' },
    ]);
    res.emit('close');
    expect(leave).toHaveBeenCalledOnce();
  });

  it('unsubscribes if the connection closes while its snapshot is pending', async () => {
    let finish!: (states: Record<string, never>) => void;
    const leave = vi.fn();
    const status = {
      snapshot: () =>
        new Promise<Record<string, never>>((resolve) => {
          finish = resolve;
        }),
      subscribe: () => leave,
    };
    const res = Object.assign(new EventEmitter(), {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      writableEnded: false,
    });
    const pending = new ThreadsController({} as never, {} as never, status as never).events(res as unknown as Response);
    res.emit('close');
    finish({});
    await pending;
    expect(res.write).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledOnce();
  });
});
