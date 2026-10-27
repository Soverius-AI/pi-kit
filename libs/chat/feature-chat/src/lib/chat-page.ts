import { LOCALIZED_CHAT_LABELS } from './chat-labels';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input } from '@angular/core';
import { ChatState, CopilotChatView, provideCopilotChatConfiguration } from '@copilotkit/angular';
import { PkBreadcrumbStrip, PkOutcomeBadge, type PkCrumb } from '@pi-kit/design-system';
import { registerGenUiRenderers } from '@pi-kit/chat/feature-genui';
import { NewThreadStore, OutcomeMenuStore, ThreadsStore, outcomeTitle, threadLabel } from '@pi-kit/threads/api';
import { GraphStore } from '@pi-kit/session-tree/api';
import { registerActivityRenderers } from './activity-renderers';
import { ChatStore } from '@pi-kit/chat/data';
import { InputContainer, PkChatState } from '@pi-kit/chat/feature-composer';
import { Transcript } from './transcript';
import { registerToolRenderers } from './tools/register';

/** The `scrollToBottomButton` slot: the "↓ Latest" pill that sits above the composer while the thread is scrolled up. */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-scroll-to-bottom',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (chat.messages().length > 0) {
      <button
        type="button"
        class="btn btn-sm shadow-float"
        [attr.aria-label]="'chat.chatPage.scrollToBottom' | transloco"
        (click)="clicked()"
      >
        {{ 'chat.chatPage.latest' | transloco }}
      </button>
    }
  `,
})
export class ScrollToBottom {
  protected readonly chat = inject(ChatStore);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  /** CopilotKit's scroll view passes the scrolling as `onClick`. */
  readonly onClick = input<(() => void) | undefined>(undefined);
  protected clicked(): void {
    const transcript = this.element.nativeElement.closest('pk-chat')?.querySelector('[pkVirtualTranscript]');
    if (transcript) transcript.dispatchEvent(new Event('pk-scroll-latest'));
    else this.onClick()?.();
  }
}

/** A slot that draws nothing (CopilotKit's gradient above the input, which the page's own background makes unnecessary). */
@Component({ selector: 'pk-nothing', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
export class Nothing {}

/**
 * The chat page: the breadcrumb strip and CopilotKit's `copilot-chat-view` with pi-kit's slots: the transcript
 * (`messageView`), the "↓ Latest" pill, the composer (`inputContainer`). `PkChatState` is what CopilotKit's `CopilotChat` would be:
 * the owner of the input value, the attachments and the suggestions. The labels of CopilotKit's own buttons are set here in one place.
 */
@Component({
  selector: 'pk-chat',
  imports: [CopilotChatView, PkBreadcrumbStrip, PkOutcomeBadge, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-chat' },
  providers: [
    PkChatState,
    { provide: ChatState, useExisting: PkChatState },
    provideCopilotChatConfiguration({ agentId: 'pi' }),
    LOCALIZED_CHAT_LABELS,
  ],
  template: `
    <pk-breadcrumb-strip [crumbs]="crumbs()">
      @if (crumbNote()) {
        {{ crumbNote() }}
      }
      @if (threads.selected()?.origin === 'cli') {
        {{ 'chat.chatPage.openedFromTheTerminal' | transloco: { value1: crumbNote() ? '·' : '' } }}
      }
      @if (threads.selected()?.state.outcome; as outcome) {
        <pk-outcome-badge crumbEnd [kind]="outcome.kind" [title]="outcomeLabel()" (pressed)="openOutcomeMenu($event)" />
      }
    </pk-breadcrumb-strip>
    <copilot-chat-view
      agentId="pi"
      [messages]="chat.messages()"
      [autoScroll]="false"
      [showCursor]="chat.working()"
      [hasExplicitThreadId]="true"
      [messageViewComponent]="transcript"
      [scrollToBottomButtonComponent]="scrollToBottom"
      [inputContainerComponent]="inputContainer"
      [featherComponent]="nothing"
    />
  `,
})
export class ChatPage {
  protected readonly i18n = inject(Language);
  protected readonly chat = inject(ChatStore);
  protected readonly threads = inject(ThreadsStore);
  private readonly tree = inject(GraphStore);
  private readonly newThreads = inject(NewThreadStore);

  protected readonly transcript = Transcript;
  protected readonly scrollToBottom = ScrollToBottom;
  protected readonly inputContainer = InputContainer;
  protected readonly nothing = Nothing;

  /**
   * The breadcrumb strip above the transcript (doc/docs/design-system.md): `main`, a crumb for every fork point of the
   * active path, the current turn, and, for a thread that was forked or cloned, where it came from.
   */
  protected readonly crumbs = computed<PkCrumb[]>(() => {
    const thread = this.threads.selected();
    if (!thread) return [{ label: this.i18n.t('chat.chatPage.noSessionOpen') }];
    // A thread that has no message yet says where its first message will run (the Where row).
    const where = this.newThreads.words();
    if (where && this.chat.messages().length === 0) return [{ label: where.crumb }];
    const crumbs: PkCrumb[] = this.tree
      .crumbs()
      .crumbs.map((c) => ({ label: c.label, tone: c.tone, ...(c.title ? { title: c.title } : {}) }));
    const parent = thread.parentThreadId
      ? this.threads.threads().find((t) => t.id === thread.parentThreadId)
      : undefined;
    if (thread.parentThreadId)
      crumbs.unshift({
        label: parent
          ? this.i18n.t('chat.chatPage.forkedFrom', { value1: threadLabel(this.i18n.t, parent) })
          : this.i18n.t('chat.chatPage.forkedFromAnotherThread'),
        tone: 'info',
      });
    // A thread in a worktree shows its branch first.
    if (thread.worktree?.exists && thread.worktree.branch) {
      crumbs.unshift({
        label: thread.worktree.branch,
        icon: 'branch',
        title: this.i18n.t('chat.chatPage.worktreeOnCutFrom', {
          value1: thread.worktree.branch,
          value2: thread.worktree.base ?? this.i18n.t('chat.chatPage.theBase'),
          value3: thread.worktree.path,
        }),
      });
    }
    return crumbs;
  });
  protected readonly crumbNote = computed(() => this.tree.crumbs().note);

  private readonly outcomeMenu = inject(OutcomeMenuStore);
  /** The outcome badge's tooltip; the thread state is pushed, the relative time is as of the last push. */
  protected readonly outcomeLabel = computed(() => {
    const thread = this.threads.selected();
    return thread?.state.outcome ? outcomeTitle(this.i18n.t, thread.state.outcome, thread.worktree?.base) : '';
  });

  /** The badge at the end of the breadcrumb strip opens the same menu as the sidebar row's. */
  protected openOutcomeMenu(event: MouseEvent): void {
    const thread = this.threads.selected();
    if (!thread) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // The menu hangs from the badge's right edge: the badge is at the end of the row.
    this.outcomeMenu.openFor(thread.id, Math.max(8, box.right - 200), box.bottom + 4);
  }

  constructor() {
    // The renderers CopilotKit draws the thread's tool calls, generated UI and activity messages with; they go with this page.
    registerToolRenderers();
    registerGenUiRenderers();
    registerActivityRenderers();
  }
}
