import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Message } from '@ag-ui/client';
import { ChatStore } from '@pi-kit/chat/data';
import type { AgentLiveTool } from '@pi-kit/chat/util';
import { ClockStore, ViewPrefs } from '@pi-kit/data-access';
import { PkLightboxService } from '@pi-kit/design-system';
import { GraphStore } from '@pi-kit/session-tree/api';
import { LearnStore, ThreadsStore } from '@pi-kit/threads/api';
import { Transcript } from './transcript';

class Rows extends Transcript {
  label(message: Message) {
    return this.rowLabel(message, {} as never);
  }
}

describe('Transcript step rows of a background agent (no pi.tool activity)', () => {
  const tools = signal<ReadonlyMap<string, AgentLiveTool>>(new Map());
  const results = signal(new Map<string, { content: string; error?: string }>());
  const message = {
    id: 'm1',
    role: 'assistant',
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
    ],
  } as Message;

  function rows(): Rows {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ChatStore,
          useValue: {
            activities: signal(new Map()),
            results,
            agentLive: () => ({ messages: [], live: undefined, tools: tools(), nested: new Map(), timing: new Map() }),
          },
        },
        { provide: ClockStore, useValue: { now: () => 0 } },
        ...[GraphStore, ViewPrefs, PkLightboxService, LearnStore, ThreadsStore].map((provide) => ({
          provide,
          useValue: {},
        })),
      ],
    });
    return TestBed.runInInjectionContext(() => new Rows());
  }

  it('shows a failed call as an error, unless another call still runs', () => {
    results.set(new Map([['c1', { content: '', error: 'exit 1' }]]));
    tools.set(new Map());
    const transcript = rows();
    expect(transcript.label(message).state).toBe('error');
    tools.set(new Map([['c2', { callId: 'c2', name: 'read', status: 'running' }]]));
    expect(transcript.label(message).state).toBe('running');
    results.set(new Map([['c1', { content: 'ok' }]]));
    tools.set(new Map());
    expect(transcript.label(message).state).toBe('done');
  });
});
