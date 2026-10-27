import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, sessionUsage } from '@pi-kit/api';
import type { ThreadUsage } from '@pi-kit/protocol';

import { ChatStore } from './chat.store';
import { CommandRegistry } from './commands';
import { UsageStore } from './usage.store';

const row = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, requests: 1 };
const usage = (over: Partial<ThreadUsage> = {}): ThreadUsage =>
  ({
    sessionId: 's',
    sessionFile: null,
    totals: { ...row, cost: 0.84, turns: 9 },
    cacheHitRatio: 0.78,
    byModel: [
      { provider: 'llama-swap', model: 'gemma-4-26b', ...row, cost: 0 },
      { provider: 'anthropic', model: 'claude-sonnet-5-5', ...row, cost: 0.71 },
      { provider: 'anthropic', model: 'claude-haiku', ...row, cost: 0.13 },
    ],
    byTurn: [],
    compactions: [],
    ...over,
  }) as ThreadUsage;

describe('UsageStore (the popover of the context ring)', () => {
  const threadId = signal<string | undefined>('t1');
  const compact = { name: 'compact', kind: 'action' };
  const chat = {
    threadId,
    findCommand: vi.fn((name: string) => (name === 'compact' ? compact : undefined)),
    say: vi.fn(),
  };
  const api = { usage: vi.fn(async (id: string) => (void id, usage())) };
  const registry = { showUsage: vi.fn(async () => undefined), run: vi.fn(async () => undefined) };

  beforeEach(() => {
    threadId.set('t1');
    for (const fn of [chat.findCommand, chat.say, api.usage, registry.showUsage, registry.run]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: chat },
        { provide: CommandRegistry, useValue: registry },
        ...provideMockApi([[sessionUsage, api.usage, (o) => [o.path?.['id']]]]),
      ],
    });
  });

  it('opens on a click, reads the usage of the thread, and lists what it cost by model, the dearest first', async () => {
    const usageStore = TestBed.inject(UsageStore);
    expect(usageStore.open()).toBe(false);
    usageStore.toggle();
    expect(usageStore.open()).toBe(true);
    await vi.waitFor(() => expect(usageStore.usage()).toBeDefined());
    expect(api.usage).toHaveBeenCalledWith('t1');
    expect(usageStore.cacheHit()).toBe('78%');
    expect(usageStore.models().map((m) => m.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku']);
    usageStore.toggle();
    expect(usageStore.open()).toBe(false);
  });

  it('shows a free local model when it is the only one, and says nothing about the cache before anything was sent', async () => {
    api.usage.mockResolvedValueOnce(
      usage({
        byModel: [{ provider: 'llama-swap', model: 'gemma-4-26b', ...row, cost: 0 }] as ThreadUsage['byModel'],
        cacheHitRatio: null,
      }),
    );
    const usageStore = TestBed.inject(UsageStore);
    usageStore.toggle();
    await vi.waitFor(() => expect(usageStore.usage()).toBeDefined());
    expect(usageStore.models()).toEqual([{ key: 'llama-swap/gemma-4-26b', model: 'gemma-4-26b', cost: 0, free: true }]);
    expect(usageStore.cacheHit()).toBeUndefined();
  });

  it('another thread closes it and forgets the numbers of the old one', async () => {
    const usageStore = TestBed.inject(UsageStore);
    usageStore.toggle();
    await vi.waitFor(() => expect(usageStore.usage()).toBeDefined());
    threadId.set('t2');
    expect(usageStore.open()).toBe(false);
    expect(usageStore.usage()).toBeUndefined();
  });

  it('"Usage by turn" closes it and opens the usage dialog; "Compact now" runs /compact', async () => {
    const usageStore = TestBed.inject(UsageStore);
    usageStore.toggle();
    await usageStore.openDialog();
    expect(usageStore.open()).toBe(false);
    expect(registry.showUsage).toHaveBeenCalledTimes(1);
    usageStore.toggle();
    await usageStore.compactNow();
    expect(usageStore.open()).toBe(false);
    expect(registry.run).toHaveBeenCalledWith(compact);
  });

  it('says so when the thread has no /compact', async () => {
    chat.findCommand.mockReturnValueOnce(undefined as never);
    const usageStore = TestBed.inject(UsageStore);
    await usageStore.compactNow();
    expect(registry.run).not.toHaveBeenCalled();
    expect(chat.say).toHaveBeenCalledWith('warning', expect.stringContaining('/compact'));
  });

  it('a failed read leaves the popover open with the reason', async () => {
    api.usage.mockRejectedValueOnce(new Error('no session file'));
    const usageStore = TestBed.inject(UsageStore);
    usageStore.toggle();
    await vi.waitFor(() => expect(usageStore.error()).toBe('no session file'));
    expect(usageStore.open()).toBe(true);
    expect(usageStore.loading()).toBe(false);
  });
});
