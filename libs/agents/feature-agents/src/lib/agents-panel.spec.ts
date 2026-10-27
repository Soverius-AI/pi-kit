import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AgentsStore } from '@pi-kit/agents/data';
import { ClockStore } from '@pi-kit/data-access';
import type { BgAgent } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { AgentsPanel } from './agents-panel';

const agent = (over: Partial<BgAgent>): BgAgent => ({ id: '1', threadId: 't1', name: 'tester', role: 'writes the tests', model: 'p/m', permission: 'edit', tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 }, context: null, brief: 'Test.', status: 'active', blocked: null, createdAt: Date.now() - 5000, finishedAt: null, cost: 0, report: null, activity: 'tool', tool: 'bash', question: null, answered: null, turns: 0, worktree: null, ...over });

describe('AgentsPanel', () => {
  const agents = signal<BgAgent[]>([]);
  // Stays closed: the transcript view needs the CopilotKit runtime, which this spec does not stand up.
  const open = signal<string | undefined>(undefined);
  const store = { agents, open, error: signal(undefined), watch: vi.fn(), openTranscript: vi.fn(), resume: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), message: vi.fn(async () => undefined), answer: vi.fn(async () => undefined) };

  beforeEach(() => {
    agents.set([agent({}), agent({ id: '2', name: 'reviewer', role: 'reviews', permission: 'read-only', status: 'done', finishedAt: Date.now(), cost: 0.0123, report: 'Reviewed src/.', activity: 'idle', tool: null })]);
    for (const fn of [store.watch, store.openTranscript, store.stop, store.remove, store.message, store.answer]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [
        { provide: ThreadsStore, useValue: { selectedId: signal('t1') } },
        // The real clock ticks every second, which would keep the fixture from settling.
        { provide: ClockStore, useValue: { now: signal(Date.now()) } },
      ] });
    TestBed.overrideComponent(AgentsPanel, { set: { providers: [{ provide: AgentsStore, useValue: store }] } });
  });

  it('lists the agents at work with what they do, and History with outcome, cost and report; Open and Stop reach the store', async () => {
    const fixture = TestBed.createComponent(AgentsPanel);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(store.watch).toHaveBeenCalledWith('t1');
    const active = root.querySelectorAll('[data-testid="agents-active"] li');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain('tester');
    // Running: the run ring in place of words, with the state and the context in its name.
    expect(active[0].querySelector('[data-testid="agent-state"]')?.getAttribute('aria-label')).toContain('bash');
    expect(active[0].querySelector('[data-testid="agent-state"]')?.classList.contains('pk-run-ring')).toBe(true);
    const history = root.querySelectorAll('[data-testid="agents-history"] li');
    expect(history).toHaveLength(1);
    expect(history[0].querySelector('[data-testid="agent-state"]')?.getAttribute('aria-label')).toBe('done');
    expect(history[0].querySelector('[data-testid="agent-state"]')?.classList.contains('ok')).toBe(true);
    expect(history[0].querySelector('[data-testid="agent-runtime"]')?.textContent?.trim()).toBe('pi-durable');
    expect(history[0].querySelector('[data-testid="agent-report"]')?.textContent).toContain('Reviewed src/.');
    // A History card is folded: its numbers show once it is opened.
    expect(history[0].querySelector('[data-testid="agent-cost"]')).toBeNull();
    (history[0].querySelector('.fold') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(history[0].querySelector('[data-testid="agent-cost"]')?.textContent).toMatch(/0\.01/);
    expect(active[0].querySelector('[data-testid="agent-tokens"]')?.textContent).toContain('1.2k in');
    expect(active[0].querySelector('[data-testid="agent-took"]')?.textContent).toMatch(/\d+s|\d+m/);
    (active[0].querySelector('[data-testid="agent-open"]') as HTMLButtonElement).click();
    expect(store.openTranscript).toHaveBeenCalledWith('1');
    expect(active[0].querySelector('[data-testid="agent-open"]')?.getAttribute('aria-label')).toBe('Open tester');
    (active[0].querySelector('[data-testid="agent-stop"]') as HTMLButtonElement).click();
    expect(store.stop).toHaveBeenCalledWith('1');
    expect(history[0].querySelector('[data-testid="agent-delete"]')?.getAttribute('aria-label')).toBe('Delete reviewer');
    (history[0].querySelector('[data-testid="agent-delete"]') as HTMLButtonElement).click();
    expect(store.remove).toHaveBeenCalledWith('2');
  });

  it('shows an agent\'s question with its choices and the last answer with Override; both reach the store', async () => {
    const question = { id: 'q2', text: 'Change greet to add punctuation?', kind: 'user' as const, choices: ['Keep as is', 'Change it'], note: 'Your call.', forwarded: true, askedAt: Date.now(), expiresAt: null };
    agents.set([
      agent({ id: '1', question, activity: 'idle', tool: null, turns: 1 }),
      agent({ id: '2', name: 'tester', answered: { question: 'Must mul accept bigint?', text: 'No, numbers only.', by: 'main', answeredAt: Date.now() } }),
    ]);
    const fixture = TestBed.createComponent(AgentsPanel);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const card = root.querySelector('[data-testid="agent-question"]') as HTMLElement;
    expect(card.textContent).toContain('Change greet to add punctuation?');
    expect(card.textContent).toContain('Your call.');
    expect(root.querySelectorAll('[data-testid="agents-active"] li')[0].querySelector('[data-testid="agent-state"]')?.textContent?.trim()).toBe('waiting for you');
    expect(root.querySelector('[data-testid="agent-turns"]')?.textContent?.trim()).toBe('1 turns');
    (Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Change it') as HTMLButtonElement).click();
    expect(store.answer).toHaveBeenCalledWith('1', 'q2', 'Change it');
    (Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Dismiss') as HTMLButtonElement).click();
    expect(store.answer).toHaveBeenLastCalledWith('1', 'q2', 'cancelled');
    expect(root.querySelector('[data-testid="agent-answered"]')?.textContent).toContain('answered by main agent: No, numbers only.');
    const form = root.querySelector('[data-testid="agent-override"]') as HTMLFormElement;
    (form.querySelector('input') as HTMLInputElement).value = 'Yes, bigint too.';
    form.requestSubmit();
    expect(store.message).toHaveBeenCalledWith('2', expect.stringContaining('Yes, bigint too.'), 'steer');
  });

  it('shows why a held agent waits and lets it go on; Resume reaches the store', async () => {
    agents.set([agent({ id: '3', name: 'tester', status: 'blocked', blocked: 'cleanup', activity: 'idle', tool: null })]);
    const fixture = TestBed.createComponent(AgentsPanel);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const held = root.querySelector('[data-testid="agent-held"]') as HTMLElement;
    expect(held.textContent).toContain('restart');
    expect(root.querySelector('[data-testid="agent-state"]')?.textContent?.trim()).toContain('held');
    (held.querySelector('[data-testid="agent-resume"]') as HTMLButtonElement).click();
    expect(store.resume).toHaveBeenCalledWith('3');
  });
});
