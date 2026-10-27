import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, type Type, computed, effect, inject, input, signal } from '@angular/core';
import type { AssistantMessage, Message, UserMessage } from '@ag-ui/client';
import {
  CopilotChatAssistantMessage,
  CopilotChatAssistantMessageRegenerateButton,
  CopilotChatAssistantMessageThumbsDownButton,
  CopilotChatAssistantMessageThumbsUpButton,
  CopilotChatMessageView,
  CopilotChatToolCallsView,
  CopilotChatUserMessage,
} from '@copilotkit/angular';
import { PkIcon, PkLightboxService, PkMarker, PkSkillDraftCard, PkThink, PkTurn } from '@pi-kit/design-system';
import type { PiActivityContent } from '@pi-kit/protocol';
import { RADIUS_FUNDS_URL, formatDuration, isOutOfFunds, newestSentence, thoughtLabel } from '@pi-kit/ui';
import { type PieceInfo, type StepPiece, type WorkPiece, percentLabel } from '@pi-kit/chat/util';
import { GraphStore } from '@pi-kit/session-tree/api';
import { LearnStore, ThreadsStore, draftCardText, draftVerifiedNote, isNewThread } from '@pi-kit/threads/api';
import { ViewPrefs, ClockStore } from '@pi-kit/data-access';
import { ChatStore, EMPTY_THREAD_PAGE, userContent } from '@pi-kit/chat/data';
import { Interrupts } from '@pi-kit/chat/feature-interrupts';
import { Prose, SkillChip } from '@pi-kit/chat/ui';
import { PkToolCall } from './tools/tool-call-scope';
import { ReplayLoading } from './replay-loading';
import { VirtualTranscript, VirtualRow } from './virtual-transcript';

/**
 * The transcript, the `messageView` slot of `CopilotChatView`: it virtualizes the messages into rows, each a CopilotKit
 * `copilot-chat-message-view` that draws one element per AG-UI message, and supplies what pi-kit puts into each of its slots:
 *
 * - `userMessage`: `CopilotChatUserMessage` with the user block (`.pk-user`), the skill and prompt-template chips over its text, the review-comments chip, its toolbar (copy, Edit =
 *   edit-and-branch, branch navigation fed by the graph's sibling turns);
 * - `assistantMessage`: `CopilotChatAssistantMessage` with the markdown renderer (`pk-prose`), the toolbar on the answer (copy,
 *   regenerate, thumbs), and tool calls through `CopilotChatToolCallsView` inside the step line and "N earlier tool calls" wrapper;
 * - `reasoningMessage`: the `pk-think` row (live line, "Thought for 8s").
 *
 * After the rows the transcript draws the end of the thread itself (context marker, approvals, the run's status) and the working dots.
 *
 * The pieces of one turn are separate siblings, so `indexTurns` (libs/chat/util) says which piece is the first, which continues a list and
 * which carries the toolbar; the CSS spaces them as one turn. Markers, `!command` blocks and the usage line are activity renderers
 * (`activity-renderers.ts`).
 */
const DISMISSED_DRAFTS = 'pk-dismissed-drafts';
function readDismissedDrafts(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_DRAFTS) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** What a tool call was given, in one short piece: the command, path, pattern or agent of its arguments. */
function callHint(args: string | undefined, max = 80): string {
  if (!args) return '';
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const key of ['command', 'path', 'file', 'pattern', 'query', 'agent', 'name', 'url', 'text']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, max);
    }
  } catch {
    /* not JSON while it streams */
  }
  return '';
}

/**
 * The transcript component (the slots it fills are described at the top of this file): it reads `ChatStore` for the messages,
 * turns and notices, `GraphStore` for the branch navigation, `ViewPrefs` for what to show and `ThreadsStore` and `LearnStore` for
 * the skill draft card, and virtualizes the rows through `VirtualTranscript`.
 */
@Component({
  selector: 'pk-transcript',
  imports: [
    CopilotChatAssistantMessage,
    CopilotChatAssistantMessageRegenerateButton,
    CopilotChatAssistantMessageThumbsDownButton,
    CopilotChatAssistantMessageThumbsUpButton,
    CopilotChatMessageView,
    CopilotChatToolCallsView,
    CopilotChatUserMessage,
    Interrupts,
    NgComponentOutlet,
    NgTemplateOutlet,
    PkIcon,
    VirtualTranscript,
    VirtualRow,
    PkMarker,
    PkSkillDraftCard,
    PkThink,
    PkToolCall,
    PkTurn,
    Prose,
    SkillChip,
    ReplayLoading,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-messages',
    '[attr.data-usage]': "prefs.showUsage() ? 'show' : null",
    '(mouseover)': 'onOver($event)',
    '(mouseleave)': 'chat.setHotTurn(undefined)',
    '[attr.aria-busy]': 'chat.connecting()',
  },
  templateUrl: './transcript.html',
})
export class Transcript {
  protected readonly i18n = inject(Language);
  // The context CopilotChatView's scroll view hands the `messageView` slot: only what this component needs is declared.
  readonly agentId = input<string | undefined>(undefined);
  readonly state = input<unknown>({});
  readonly showCursor = input(false);

  protected readonly chat = inject(ChatStore);
  protected readonly tree = inject(GraphStore);
  protected readonly prefs = inject(ViewPrefs);
  private readonly clock = inject(ClockStore);
  /** A sent image opens full size (the lightbox of the shell). */
  protected readonly lightbox = inject(PkLightboxService);

  /** User messages whose review comments are listed. */
  protected readonly reviewOpen = signal<ReadonlySet<string>>(new Set());
  protected readonly hot = this.chat.hotTurn;
  protected readonly outOfFunds = isOutOfFunds;
  protected readonly fundsUrl = RADIUS_FUNDS_URL;
  protected readonly contextLabel = computed(() => percentLabel(this.chat.contextPercent() ?? 0));
  protected readonly lastId = computed(() => this.chat.messages().at(-1)?.id);
  /** Activities used as backing state and folded steps do not need an empty virtual row. */
  protected readonly visibleMessages = computed(() =>
    this.chat.transcriptMessages().filter((message, index, all) => {
      if (message.role === 'user') {
        // A message shown before the backend recorded it (sent to a background agent) goes once its recorded twin follows it.
        if (!this.chat.optimisticIds().includes(message.id)) return true;
        const mine = userContent(message as UserMessage);
        return !all.some((other, i) => {
          if (i <= index || other.role !== 'user') return false;
          const theirs = userContent(other as UserMessage);
          return theirs.text === mine.text && theirs.images.length === mine.images.length;
        });
      }
      if (message.role === 'assistant') {
        const piece = this.pieceOf(message.id);
        return !!piece && this.visible(message, piece);
      }
      if (message.role === 'reasoning') {
        const piece = this.pieceOf(message.id);
        return !!piece && (!piece.work || piece.work.first || this.workOpen(piece.work));
      }
      if (message.role !== 'activity') return false;
      if (['pi.tool', 'pi.diff', 'pi.widget', 'pi.review', 'pi.skills'].includes(message.activityType)) return false;
      if (message.activityType === 'pi.bash') return message.id.startsWith('bash:user:');
      if (message.activityType === 'pi.turn_usage') return this.chat.turns().usage.has(message.id);
      return true;
    }),
  );

  /** The new-thread page, once a thread without messages asked for it (it decides by itself whether the thread is a new one). */
  private readonly emptyLoader = inject(EMPTY_THREAD_PAGE, { optional: true });
  protected readonly emptyPage = signal<Type<unknown> | null>(null);
  /** The new-thread page says what to do in this thread; the plain empty-thread line is for the empty threads that page does not take (a CLI session, a worktree one). */
  protected readonly onNewThreadPage = computed(() => isNewThread(this.threads.selected()));
  private readonly wantsEmptyPage = computed(() => !!this.chat.threadId() && this.chat.messages().length === 0);

  constructor() {
    effect(() => {
      if (this.wantsEmptyPage() && !this.emptyPage() && this.emptyLoader)
        void this.emptyLoader().then((page) => this.emptyPage.set(page));
    });
  }

  protected readonly learn = inject(LearnStore);
  private readonly threads = inject(ThreadsStore);
  /** The open thread's skill draft while it waits for the person: the card at the end of the thread. */
  protected readonly pendingDraft = computed(() => {
    const thread = this.threads.selected();
    const draft = thread?.state.draft;
    return thread && draft?.state === 'pending' && !this.dismissedDrafts().has(draft.id)
      ? { ...draft, threadId: thread.id }
      : undefined;
  });
  /** Draft cards the person dismissed (kept across restarts in this browser profile): the draft itself stays pending, in the thread menu. */
  private readonly dismissedDrafts = signal(readDismissedDrafts());
  protected dismissDraft(id: string): void {
    const next = new Set(this.dismissedDrafts()).add(id);
    this.dismissedDrafts.set(next);
    try {
      localStorage.setItem(DISMISSED_DRAFTS, JSON.stringify([...next].slice(-200)));
    } catch {
      /* private window: the dismissal lasts this session */
    }
  }
  protected readonly draftLead = draftCardText.bind(undefined, this.i18n.t);
  protected readonly draftNote = draftVerifiedNote.bind(undefined, this.i18n.t);

  private readonly userBlocks = computed(
    () => new Map(this.chat.blocks().flatMap((b) => (b.kind === 'user' ? [[b.id, b] as const] : []))),
  );
  private readonly singles = new WeakMap<object, WeakMap<object, AssistantMessage>>();
  private readonly textOnlys = new WeakMap<object, UserMessage>();

  protected pieceOf(id: string): PieceInfo | undefined {
    return this.chat.turns().pieces.get(id);
  }

  protected turnKey(piece: PieceInfo): string {
    return piece.after ?? piece.block;
  }

  protected contOf(piece: PieceInfo): string | null {
    return piece.contActivity ? 'activity' : piece.cont ? 'turn' : null;
  }

  protected onOver(event: Event): void {
    const el = (event.target as HTMLElement | null)?.closest?.('[data-turn]');
    this.chat.setHotTurn(el?.getAttribute('data-turn') ?? undefined);
  }

  // ---- user messages

  /** The message CopilotKit's user block gets: its text only, because the images are drawn inside the block. */
  protected textOnly(message: Message): UserMessage {
    const cached = this.textOnlys.get(message);
    if (cached) return cached;
    const made = { ...message, content: userContent(message).text } as UserMessage;
    this.textOnlys.set(message, made);
    return made;
  }

  protected imagesOf(message: Message): string[] {
    return userContent(message).images.map((i) => `data:${i.mimeType};base64,${i.data}`);
  }

  /** A sent image, full size in the lightbox of the shell. */
  protected preview(src: string): void {
    this.lightbox.open({ src, caption: this.i18n.t('chat.transcript.attachedImage') });
  }

  protected reviewOf(id: string) {
    return this.userBlocks().get(id)?.review;
  }

  /** The skill and prompt-template chips the message was sent with. */
  protected skillsOf(id: string) {
    return this.userBlocks().get(id)?.skills;
  }

  /** The background agent a message is attributed to: the name the stored message carries, else the one this stream named, else its id. */
  protected agentOf(message: Message): string | undefined {
    const { subagentRunId, subagentName } = message as { subagentRunId?: string; subagentName?: string };
    const id = subagentRunId?.split('/')[0];
    if (!id) return undefined;
    const threadId = this.chat.threadId();
    return subagentName || (threadId && this.chat.agentNames()[threadId]?.[id]) || id;
  }

  /** The first line of a message from an agent, for its folded row. */
  protected firstLine(text: string): string {
    return (
      text
        .split('\n')
        .find((line) => line.trim())
        ?.trim()
        .replace(/^Report from agent "[^"]*": ?/, '')
        .slice(0, 160) ?? ''
    );
  }

  /** The sentence a review message opens with (the comments follow it, and the chip lists them). */
  protected preamble(text: string): string {
    return text.split('\n\n')[0];
  }

  protected toggleReview(id: string): void {
    this.reviewOpen.update((set) => this.toggled(set, id));
  }

  // ---- reasoning

  protected thinkOf(message: Message): {
    state: 'streaming' | 'done';
    label: string;
    live: string;
    meta: string;
    paragraphs: string[];
  } {
    const text = typeof message.content === 'string' ? message.content : '';
    const timing = this.chat.thinkTimes()[message.id];
    const live = this.chat.running() && this.lastId() === message.id;
    const streaming = this.chat.running() && (timing ? timing.start !== undefined && timing.end === undefined : live);
    const elapsed = timing?.start !== undefined ? (timing.end ?? this.clock.now()) - timing.start : undefined;
    return {
      state: streaming ? 'streaming' : 'done',
      label: streaming
        ? this.i18n.t('chat.transcript.thinking')
        : thoughtLabel(
            this.i18n.t,
            timing?.start !== undefined && timing.end !== undefined ? timing.end - timing.start : undefined,
          ),
      live: newestSentence(text),
      // The size of a finished trace belongs to the usage line; the row says only how long pi thought.
      meta: streaming && elapsed !== undefined ? formatDuration(elapsed) : '',
      paragraphs: text.split(/\n{2,}/).filter((p) => p.trim()),
    };
  }

  // ---- assistant messages

  /** Has the piece anything to draw? Steps folded away and empty messages draw nothing (and take no space). */
  protected visible(message: Message, piece: PieceInfo): boolean {
    if (piece.work && !piece.work.first && !this.workOpen(piece.work)) return false;
    const text = typeof message.content === 'string' && message.content.trim().length > 0;
    return text || !!piece.step;
  }

  /** Every step draws inside its row of the work group; the fold ("N earlier tool calls") is the group now. */
  protected stepShown(step: StepPiece): boolean {
    return !!step;
  }

  // ---- the work group

  /** The groups and rows the person opened or closed by hand; without a choice, a group is open while its turn works, and so is its last row. */
  private readonly workToggles = signal<ReadonlyMap<string, boolean>>(new Map());

  /** The group is the one the running turn adds to: the last block, without an answer yet. An earlier turn that ended on a tool is not. */
  protected working(work: WorkPiece): boolean {
    return work.unanswered && this.chat.running() && this.chat.turns().lastBlock === work.group;
  }

  protected workOpen(work: WorkPiece): boolean {
    return this.workToggles().get(work.group) ?? this.working(work);
  }

  protected toggleWork(work: WorkPiece): void {
    const open = this.workOpen(work);
    this.workToggles.update((map) => new Map(map).set(work.group, !open));
  }

  /** The newest row stays open while the turn works (the browser keeps whatever the person toggles afterwards). */
  protected rowOpen(work: WorkPiece): boolean {
    return work.last && this.working(work);
  }

  /** "Ran 7 tool calls", or "Working · 3 tool calls so far" while the turn goes. */
  protected workLabel(work: WorkPiece): string {
    const unit = this.i18n.t(work.calls === 1 ? 'chat.transcript.call' : 'chat.transcript.calls');
    return this.i18n.t(this.working(work) ? 'chat.transcript.workingCalls' : 'chat.transcript.ranCalls', {
      value1: work.calls,
      value2: unit,
    });
  }

  /** One line for a step row: the tool and what it was given, or "3 tool calls · read, bash…"; an interim text row shows its first line. */
  protected rowLabel(
    message: Message,
    _piece: PieceInfo,
  ): { text: string; hint: string; title: string; meta: string; state: 'running' | 'done' | 'error' } {
    const calls = (message as AssistantMessage).toolCalls ?? [];
    const activities = this.chat.activities();
    let state: 'running' | 'done' | 'error' = 'done';
    let first = Infinity;
    let end = 0;
    for (const call of calls) {
      const info = activities.get(`tool:${call.id}`)?.content as PiActivityContent<'pi.tool'> | undefined;
      if (!info) continue;
      if (info.status === 'running') state = 'running';
      else if (info.status === 'error' && state !== 'running') state = 'error';
      if (info.startedAt) first = Math.min(first, info.startedAt);
      end = Math.max(end, info.status === 'running' ? this.clock.now() : info.startedAt + (info.durationMs ?? 0));
    }
    const meta = Number.isFinite(first) && end - first >= 1000 ? formatDuration(end - first) : '';
    if (calls.length === 0) {
      const text = typeof message.content === 'string' ? message.content : '';
      return {
        text:
          text
            .split('\n')
            .find((line) => line.trim())
            ?.trim()
            .slice(0, 100) ?? '',
        hint: '',
        title: text.slice(0, 1000),
        meta,
        state,
      };
    }
    if (calls.length === 1)
      return {
        text: calls[0].function.name,
        hint: callHint(calls[0].function.arguments),
        title: `${calls[0].function.name} ${callHint(calls[0].function.arguments, 1000)}`,
        meta,
        state,
      };
    const names = [...new Set(calls.map((call) => call.function.name))];
    return {
      text: this.i18n.t('chat.transcript.rowCalls', {
        value1: calls.length,
        value2: this.i18n.t('chat.transcript.calls'),
      }),
      hint: names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : ''),
      title: calls.map((call) => `${call.function.name} ${callHint(call.function.arguments, 200)}`).join('\n'),
      meta,
      state,
    };
  }

  /** The same message with one of its tool calls: CopilotKit's view draws every call of a message, ours draws them one by one (it needs the id of each). */
  protected single(message: Message, call: object): AssistantMessage {
    let per = this.singles.get(call);
    if (!per) this.singles.set(call, (per = new WeakMap()));
    const hit = per.get(message);
    if (hit) return hit;
    const made = { ...message, toolCalls: [call] } as AssistantMessage;
    per.set(message, made);
    return made;
  }

  /** The "Step 2 of 3, 4 tool calls" line; undefined when the turn has a single step. */
  protected stepLine(
    message: { toolCalls?: { id: string }[] },
    step: StepPiece,
    id: string,
  ): { text: string; done: number; total: number; elapsed: string } | undefined {
    if (step.of < 2) return undefined;
    const activities = this.chat.activities();
    const calls = message.toolCalls ?? [];
    let done = 0;
    let first = Infinity;
    let end = 0;
    for (const call of calls) {
      const info = activities.get(`tool:${call.id}`)?.content as PiActivityContent<'pi.tool'> | undefined;
      if (!info) continue;
      if (info.status !== 'running') done += 1;
      if (info.startedAt) first = Math.min(first, info.startedAt);
      end = Math.max(end, info.status === 'running' ? this.clock.now() : info.startedAt + (info.durationMs ?? 0));
    }
    const latestWhileRunning = this.chat.running() && this.lastId() === id;
    const n = calls.length;
    return {
      text: this.i18n.t('chat.transcript.stepTool', {
        value1: step.index,
        value2: latestWhileRunning ? '' : this.i18n.t('chat.transcript.of', { value1: step.of }),
        value3: n,
        value4: n === 1 ? this.i18n.t('chat.transcript.call') : this.i18n.t('chat.transcript.calls'),
      }),
      done,
      total: n,
      elapsed: Number.isFinite(first) && end - first >= 1000 ? formatDuration(end - first) : '',
    };
  }

  private toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  }
}
