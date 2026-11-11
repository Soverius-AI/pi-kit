import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatStore, TRANSCRIPT_VIEW } from '@pi-kit/chat/api';
import type { BgAgent } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { AgentTranscript } from './agent-transcript';

@Component({ selector: 'pk-test-view', template: '' })
class EmptyView {}

class TranscriptPage {
  static readonly chat = {
    running: signal(false),
    reconnect: vi.fn(),
    setPlaceholder: vi.fn(),
    setBehavior: vi.fn(),
  };

  static agent(over: Partial<BgAgent> = {}): BgAgent {
    return {
      id: 'a1',
      threadId: 't1',
      name: 'tester',
      role: 'tests',
      model: null,
      permission: 'edit',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      context: null,
      brief: 'Test.',
      status: 'active',
      blocked: null,
      createdAt: 1,
      finishedAt: null,
      cost: 0,
      report: null,
      activity: 'idle',
      tool: null,
      question: null,
      answered: null,
      turns: 0,
      worktree: null,
      liveSyncs: 0,
      ...over,
    };
  }

  static async render() {
    TestBed.overrideComponent(AgentTranscript, {
      set: {
        template: '',
        imports: [],
        providers: [
          { provide: ChatStore, useValue: TranscriptPage.chat },
          { provide: ThreadsStore, useValue: { agent: signal(undefined) } },
        ],
      },
    });
    const fixture = TestBed.createComponent(AgentTranscript);
    fixture.componentRef.setInput('agent', TranscriptPage.agent());
    await fixture.whenStable();
    return async (over: Partial<BgAgent>) => {
      fixture.componentRef.setInput('agent', TranscriptPage.agent(over));
      await fixture.whenStable();
    };
  }
}

describe('AgentTranscript', () => {
  const { chat } = TranscriptPage;

  beforeEach(() => {
    chat.running.set(false);
    chat.reconnect.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: TRANSCRIPT_VIEW, useValue: EmptyView }] });
  });

  it('joins an idle agent again as a sync when its live state changed, and as a run when it starts working', async () => {
    const update = await TranscriptPage.render();
    expect(chat.reconnect).not.toHaveBeenCalled();
    await update({ liveSyncs: 1 });
    expect(chat.reconnect).toHaveBeenLastCalledWith({ sync: true });
    await update({ liveSyncs: 1, turns: 1 });
    expect(chat.reconnect).toHaveBeenCalledTimes(1);
    await update({ liveSyncs: 2, activity: 'running' });
    expect(chat.reconnect).toHaveBeenLastCalledWith({ sync: false });
    expect(chat.reconnect).toHaveBeenCalledTimes(2);
  });

  it('does not join again while a run already streams into this store', async () => {
    const update = await TranscriptPage.render();
    chat.running.set(true);
    await update({ liveSyncs: 3 });
    expect(chat.reconnect).not.toHaveBeenCalled();
  });
});
