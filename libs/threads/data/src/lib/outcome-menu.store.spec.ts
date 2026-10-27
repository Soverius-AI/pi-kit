import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ThreadSummary } from '@pi-kit/protocol';
import { idleState, thread } from '@pi-kit/testing';
import { OUTCOME_PR, OUTCOME_SHOW, OutcomeMenuStore } from './outcome-menu.store';
import { ThreadShell } from './ports';
import { ThreadsStore } from './threads.store';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('OutcomeMenuStore', () => {
  const shell = { openOutcome: vi.fn(async () => undefined) };
  let threads: ReturnType<typeof signal<ThreadSummary[]>>;

  const make = () => TestBed.inject(OutcomeMenuStore);

  beforeEach(() => {
    vi.clearAllMocks();
    threads = signal<ThreadSummary[]>([
      thread('merged', { state: idleState({ outcome: { kind: 'merged', head: HEAD, at: 1 } }) }),
      thread('pr', {
        state: idleState({ outcome: { kind: 'pr', head: HEAD, at: 1, url: 'https://example.test/pr/1' } }),
      }),
      thread('plain'),
    ]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: { threads } },
        { provide: ThreadShell, useValue: shell },
      ],
    });
  });

  it('offers "Show the outcome", and for a pull request "Open the pull request"', () => {
    const menu = make();
    menu.openFor('merged', 10, 20);
    expect(menu.open()).toEqual({ threadId: 'merged', x: 10, y: 20 });
    expect(menu.items().map((i) => i.label)).toEqual(['Show the outcome']);
    menu.openFor('pr', 10, 20);
    expect(menu.items().map((i) => [i.id, i.label])).toEqual([
      [OUTCOME_SHOW, 'Show the outcome'],
      [OUTCOME_PR, 'Open the pull request'],
    ]);
  });

  it('has nothing for a thread without an outcome, and closes', () => {
    const menu = make();
    menu.openFor('plain', 1, 1);
    expect(menu.items()).toEqual([]);
    menu.close();
    expect(menu.open()).toBeUndefined();
  });

  it('"Show the outcome" asks the shell to open the thread on its outcome and closes the menu', async () => {
    const menu = make();
    menu.openFor('merged', 1, 1);
    await menu.choose(OUTCOME_SHOW);
    expect(shell.openOutcome).toHaveBeenCalledWith('merged');
    expect(menu.open()).toBeUndefined();
  });

  it('"Open the pull request" opens its address in a new window, without an opener', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const menu = make();
    menu.openFor('pr', 1, 1);
    await menu.choose(OUTCOME_PR);
    expect(open).toHaveBeenCalledWith('https://example.test/pr/1', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('is the extension point of the learning package: contributed items follow the built-in ones and run when chosen', async () => {
    const menu = make();
    const run = vi.fn();
    const remove = menu.extend({ items: (t) => [{ id: 'learn:draft', label: `Learn a skill from ${t.id}` }], run });
    menu.openFor('merged', 1, 1);
    expect(menu.items().map((i) => i.id)).toEqual([OUTCOME_SHOW, 'learn:draft']);
    await menu.choose('learn:draft');
    expect(run).toHaveBeenCalledWith('learn:draft', expect.objectContaining({ id: 'merged' }));
    expect(shell.openOutcome).not.toHaveBeenCalled();
    remove();
    menu.openFor('merged', 1, 1);
    expect(menu.items().map((i) => i.id)).toEqual([OUTCOME_SHOW]);
  });
});
