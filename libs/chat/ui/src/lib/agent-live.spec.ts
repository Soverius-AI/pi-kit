import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AbstractAgent, type BaseEvent, EventType, type Message, type RunAgentInput } from '@ag-ui/client';
import { type AgentLivePin, AgentLiveState } from '@pi-kit/chat/util';
import { ClockStore } from '@pi-kit/data-access';
import type { PiLiveState } from '@pi-kit/protocol';
import { from, type Observable } from 'rxjs';
import { AgentLive } from './agent-live';

const NOW = 1_800_000_000_000;

class FixtureAgent extends AbstractAgent {
  constructor(
    private readonly events: BaseEvent[],
    initialMessages: Message[],
  ) {
    super({ threadId: 'a1', initialMessages });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const run = { threadId: input.threadId, runId: input.runId };
    return from([
      { type: EventType.RUN_STARTED, ...run },
      ...this.events,
      { type: EventType.RUN_FINISHED, ...run },
    ] as BaseEvent[]);
  }
}

class LiveFixture {
  static readonly id = 'agent-live:a1';

  static snapshot(live: PiLiveState): BaseEvent {
    return {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: LiveFixture.id,
      activityType: 'pi.agent_live',
      content: { docs: { 'pi.live': live } },
    } as BaseEvent;
  }

  static delta(...patch: { op: string; path: string; value?: unknown }[]): BaseEvent {
    return {
      type: EventType.ACTIVITY_DELTA,
      messageId: LiveFixture.id,
      activityType: 'pi.agent_live',
      patch,
    } as BaseEvent;
  }

  static committed(id: string, text: string): BaseEvent[] {
    return [
      { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text },
      { type: EventType.TEXT_MESSAGE_END, messageId: id },
    ] as BaseEvent[];
  }

  static call(messageId: string, toolCallId: string, name: string): BaseEvent[] {
    return [
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name, parentMessageId: messageId },
      { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: '{"command":"npm test"}' },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ] as BaseEvent[];
  }

  static async apply(events: BaseEvent[]): Promise<Message[]> {
    const agent = new FixtureAgent(events, [{ id: 'u1', role: 'user', content: 'Fix the build' }]);
    await agent.runAgent();
    return agent.messages;
  }

  static render(live: PiLiveState, pin?: Pick<AgentLivePin, 'nested' | 'timing'>): HTMLElement {
    const fixture = TestBed.createComponent(AgentLive);
    fixture.componentRef.setInput('live', live);
    if (pin) {
      fixture.componentRef.setInput('nested', pin.nested);
      fixture.componentRef.setInput('timing', pin.timing);
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  static notes(root: HTMLElement): Record<string, (string | undefined)[]> {
    return Object.fromEntries(
      Array.from(root.querySelectorAll('pk-notice')).map((n) => [
        n.getAttribute('data-note'),
        [n.querySelector('span')?.textContent, n.querySelector('[data-testid="notice-detail"]')?.textContent],
      ]),
    );
  }
}

describe('AgentLive', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ClockStore, useValue: { now: signal(NOW) } }] });
  });

  it('draws the snapshot as @ag-ui/client patches it with each delta, leaving row tools to the transcript', async () => {
    const messages = await LiveFixture.apply([
      LiveFixture.snapshot({
        run: { turns: 1 },
        generation: { attempt: 1 },
        tools: [{ callId: 'c1', name: 'bash', status: 'running' }],
      }),
      ...LiveFixture.committed('m1', 'Running the tests'),
      ...LiveFixture.call('m2', 'c1', 'bash'),
      LiveFixture.delta({ op: 'add', path: '/docs/pi.usage~1turn', value: { input: 10 } }),
      LiveFixture.delta({
        op: 'add',
        path: '/docs/pi.live/tools/-',
        value: { callId: 'c2', name: 'agent', status: 'running', output: 'line 41\nline 42', droppedLines: 40 },
      }),
      LiveFixture.delta({ op: 'add', path: '/timing', value: { c2: { startedAt: NOW - 12_000 } } }),
      LiveFixture.delta({
        op: 'add',
        path: '/docs/pi.live/nestedTools',
        value: [
          {
            callId: 'n1',
            parentCallId: 'c2',
            name: 'read',
            status: 'done',
            arguments: { path: 'src/app.ts' },
            summary: { isError: true, error: 'ENOENT' },
          },
        ],
      }),
    ]);
    expect(messages.map((m) => m.id)).toEqual(['u1', LiveFixture.id, 'm1', 'm2']);
    expect((messages[1].content as { docs: Record<string, unknown> }).docs['pi.usage/turn']).toEqual({ input: 10 });
    const pinned = AgentLiveState.pin(messages, 'a1');
    expect(pinned.messages.map((m) => m.id)).toEqual(['u1', 'm1', 'm2']);
    expect(pinned.tools.has('c1')).toBe(true);

    const root = LiveFixture.render(pinned.live!, pinned);
    expect(root.querySelector('[data-call="c1"]')).toBeNull();
    expect(root.querySelector('pk-prose, pk-think')).toBeNull();
    const agent = root.querySelector('[data-call="c2"]')!;
    expect(agent.querySelector('.pk-row .sub')?.textContent).toBe('Running, 12s');
    expect(agent.querySelector('[data-testid="tool-output"] .meta')?.textContent).toBe('… 40 earlier lines not shown');
    const nested = agent.querySelector('[data-nested] [data-call="n1"] .pk-row')!;
    expect(nested.getAttribute('data-state')).toBe('error');
    expect(nested.textContent).toContain('src/app.ts');
    expect(nested.querySelector('.sub')?.textContent).toBe('ENOENT');
    expect(root.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('The agent is working');
  });

  it('notes bytes cut from a finished tool with its duration, and shows no busy dots without a run', () => {
    const root = LiveFixture.render(
      { tools: [{ callId: 'c1', name: 'bash', status: 'done', output: 'ok', droppedBytes: 2048 }] },
      { nested: new Map(), timing: new Map([['c1', { startedAt: NOW - 4_000, endedAt: NOW - 1_000 }]]) },
    );
    expect(root.querySelector('.meta')?.textContent).toBe('… 2048 earlier bytes not shown');
    expect(root.querySelector('[data-call="c1"] .stat')?.textContent).toBe('3s');
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('shows retries, deferred polling and compaction with their untranslated errors as detail', () => {
    const root = LiveFixture.render({
      generation: {
        attempt: 2,
        retry: { at: NOW + 12_000, error: '429 Too Many Requests' },
        deferred: { pollAt: NOW - 1 },
      },
      compactions: [{ trigger: 'threshold', blocking: true, attempt: 2, retry: { at: NOW + 3_000, error: 'timeout' } }],
      compactionFailure: { trigger: 'overflow', error: 'summary too long' },
    });
    expect(LiveFixture.notes(root)).toEqual({
      retry: ['The request failed; retrying in 12s', '429 Too Many Requests'],
      deferred: ['Waiting for the provider; checking again now', undefined],
      'compaction-retry-0': ['Compaction failed; retrying in 3s', 'timeout'],
      'compaction-failure': ['Compaction failed', 'summary too long'],
    });
    expect(root.querySelector('pk-marker')?.textContent).toContain('Compacting context…');
  });

  it.each([
    ['model_error', 'The model returned an error'],
    ['no_model', 'No model is available for this agent'],
    ['aborted', 'The run was stopped'],
    ['reset', 'The run was reset'],
    ['faulted', 'The agent ran into an internal error'],
    ['orphaned', 'The run lost its process and was ended'],
    ['interrupted', 'The run was interrupted'],
    ['restart_limit', 'The agent stopped after restarting too often'],
    ['nothing_to_answer', 'There was nothing to answer'],
    ['turn_limit', 'The agent reached its turn limit'],
    ['quota_gone', 'The run ended without an answer (quota_gone)'],
  ])('translates the run failure %s and keeps its detail as technical text', (reason, text) => {
    const root = LiveFixture.render({ runFailure: { reason, detail: 'HTTP 500' } });
    const notice = root.querySelector('[data-note="run-failure"]')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.querySelector('span')?.textContent).toBe(text);
    expect(notice.querySelector('[data-testid="notice-detail"]')?.textContent).toBe('HTTP 500');
  });
});
