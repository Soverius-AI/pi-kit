import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CopilotChatView, provideCopilotChatConfiguration } from '@copilotkit/angular';
import { AGENT_INPUT_VIEW, CHAT_AGENT, ChatStore, ComposerExtensions, TRANSCRIPT_VIEW } from '@pi-kit/chat/api';
import { ThreadsStore } from '@pi-kit/threads/api';
import { EMPTY } from 'rxjs';
import type { BgAgent, ThreadSummary } from '@pi-kit/protocol';

/** The agent as the chat store's thread selection: the agent's id is the `pi-bg` thread id, nothing else of a thread applies. */
function agentAsThreads() {
  const agent = signal<BgAgent | undefined>(undefined);
  const selected = computed<ThreadSummary | undefined>(() => {
    const a = agent();
    if (!a) return undefined;
    const state: ThreadSummary['state'] = {
      activity: 'idle',
      question: null,
      context: null,
      lastRun: null,
      unread: false,
      unseen: false,
      cli: false,
      summary: null,
      suggestions: [],
      outcome: null,
      draft: null,
    };
    return {
      id: a.id,
      cwd: '',
      title: a.name,
      preview: a.brief,
      pinned: false,
      updatedAt: a.createdAt,
      lastOpenedAt: null,
      state,
      running: false,
      waiting: false,
      lastRun: null,
    } as unknown as ThreadSummary;
  });
  return {
    /** The component sets it from its input; the stand-in cannot inject the component while it is being made. */
    agent,
    selected,
    selectedId: computed(() => selected()?.id),
    cwd: () => undefined,
    folder: () => undefined,
    workspace: () => undefined,
    workspaces: signal([]),
    threads: signal<ThreadSummary[]>([]),
    folderChanges: EMPTY,
    refresh: async () => undefined,
    select: () => undefined,
    want: () => undefined,
    onStatusEvent: () => () => undefined,
  };
}

/** A slot that draws nothing: a stopped or failed agent takes no messages (a done one does: it goes back to work), and the feather is the thread's. */
@Component({ selector: 'pk-agent-nothing', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
export class AgentNothing {}

/**
 * A background agent's transcript: the chat domain's transcript on the AG-UI agent `pi-bg`, read-only. The component
 * provides a `ChatStore` of its own that follows `pi-bg` instead of `pi`, with the agent as its "thread", so every piece of the transcript
 * (turns, tool rows, activities, generated UI) is the same code as a thread's.
 */
@Component({
  selector: 'pk-agent-transcript',
  imports: [CopilotChatView, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `pk-chat`: the chat view's scroll rules (components.css) are scoped to it; without it the transcript does not scroll.
  host: { class: 'pk-chat pk-agent-transcript flex-1 min-h-0 flex flex-col', 'data-testid': 'agent-transcript' },
  providers: [
    { provide: CHAT_AGENT, useValue: { agentId: 'pi-bg', session: false } },
    { provide: ThreadsStore, useFactory: agentAsThreads },
    // A composer registry of its own: the thread's (root) one keeps the thread's `/` menu and send steps, this one stays empty.
    ComposerExtensions,
    ChatStore,
    provideCopilotChatConfiguration({ agentId: 'pi-bg' }),
  ],
  template: `
    <div class="t-xs muted px-3 py-1">
      {{ 'agents.agentsPanel.transcriptOf' | transloco: { value1: agent().name } }}
    </div>
    <copilot-chat-view
      class="flex-1 min-h-0"
      agentId="pi-bg"
      [messages]="chat.messages()"
      [autoScroll]="true"
      [showCursor]="chat.running()"
      [hasExplicitThreadId]="true"
      [messageViewComponent]="view"
      [inputContainerComponent]="agent().status === 'stopped' || agent().status === 'failed' ? nothing : input"
      [featherComponent]="nothing"
    />
  `,
})
export class AgentTranscript {
  readonly agent = input.required<BgAgent>();
  private readonly i18n = inject(Language);
  protected readonly chat = inject(ChatStore);
  protected readonly view = inject(TRANSCRIPT_VIEW);
  /** The thread composer's well and field on the agent's store (chat/feature-composer, through the token): follow-ups and steers go to the agent. */
  protected readonly input = inject(AGENT_INPUT_VIEW, { optional: true }) ?? AgentNothing;
  protected readonly nothing = AgentNothing;
  private readonly stand = inject(ThreadsStore) as unknown as ReturnType<typeof agentAsThreads>;

  /** What the agent was doing at the last change, so a start is told from a change of anything else. */
  private last: { activity: BgAgent['activity']; status: BgAgent['status'] } | undefined;

  constructor() {
    effect(() => this.stand.agent.set(this.agent()));
    effect(() => this.chat.setPlaceholder(this.i18n.t('agents.agentsPanel.messageTo', { value1: this.agent().name })));
    // The agent's stream ends when it is idle; when it starts again (a message from the composer, a resume), the store joins it anew, as a thread
    // joins a turn it did not start. The agents list over the status channel is what says so here.
    effect(() => {
      const current = this.agent();
      const before = this.last;
      this.last = { activity: current.activity, status: current.status };
      const started =
        before &&
        ((before.activity === 'idle' && current.activity !== 'idle') ||
          (before.status !== 'active' && current.status === 'active'));
      // A run this store started itself (a message from the composer) is followed already: only a start from elsewhere needs the join.
      if (started)
        untracked(() => {
          if (!this.chat.running()) this.chat.reconnect();
        });
    });
    // A message to an agent is its next task unless the person picks Steer: the thread's default of steering mid-run does not fit here.
    this.chat.setBehavior('followUp');
  }
}
