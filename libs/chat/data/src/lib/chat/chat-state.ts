import type { Translate } from '@pi-kit/i18n';
import { type Message } from '@ag-ui/client';
import {
  type Command,
  type ComposerChip,
  type FeedbackRating,
  type ModelList,
  type QueueSnapshot,
  type SessionStats,
} from '@pi-kit/protocol';
import { type CompletionItem } from '../composer-extensions';
export interface Notice {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface ThinkTiming {
  start?: number;
  end?: number;
}

/** An image on its way into the next message (pasted, dropped or picked): base64 without the `data:` prefix. */
export interface ImageAttachment {
  id: string;
  mimeType: string;
  data: string;
  name?: string;
}

/** Where the pinned chips of the threads are kept between launches: a convenience, so `localStorage` only. */
export const PINNED_KEY = 'pi-kit.pinned-chips';
export interface ChatStoreState {
  // ---- the conversation
  /** Bumped to open the replay stream again (after `/compact`, `/reload`, a moved leaf). */
  reconnects: number;
  thinkTimes: Record<string, ThinkTiming>;
  /** pi's queue of messages waiting for the running turn (`pi.queue` events, and the endpoint after a reload). */
  queue: QueueSnapshot;
  compacting: boolean;
  retry: { attempt: number; maxAttempts: number; reason: string } | undefined;
  runError: { message: string; code?: string } | undefined;
  /** The last run ended because the user stopped it ("Rerun last" is offered). */
  lastAborted: boolean;
  /** Authoritative hydration/lifecycle status; cached session statistics can still describe an earlier prompt. */
  promptActive: boolean | undefined;
  statuses: Record<string, string>;
  notices: Notice[];
  /** Locally consumed predictions are hidden before the status channel acknowledges them. */
  hiddenFollowUps: number[];
  acceptingFollowUp: number | undefined;
  /** The background agents a thread's stream named (`SUBAGENT_STARTED`), by thread id and agent id: what an attributed message is labelled with. */
  agentNames: Record<string, Record<string, string>>;
  /** Tokens in context according to the latest `pi.usage`, and what this session's live runs added to the stats (cost, tokens, turns). */
  liveContextTokens: number | undefined;
  liveCost: number;
  liveTokens: number;
  liveTurns: number;
  stats: SessionStats | undefined;
  commands: Command[];
  commandsLoading: boolean;
  commandsError: string | undefined;
  // ---- model and effort
  modelList: ModelList | undefined;
  modelError: string | undefined;
  /** Set when the model or effort was changed while a run was going: it applies to the next request. */
  changedDuringRun: { model: boolean; effort: boolean } | undefined;
  // ---- the composer
  draft: string;
  caret: number;
  /** A request for the textarea to move its caret (set after the draft was replaced); `n` makes equal positions distinct. */
  caretRequest: { pos: number; n: number } | undefined;
  images: ImageAttachment[];
  /**
   * The skill and prompt-template chips of the composer, by thread: the ones for the next message and the pinned ones, which stay on
   * the messages after it until unpinned. The pinned ones are remembered between launches; the others live as long as the draft does.
   */
  chipsByThread: Record<string, ComposerChip[]>;
  behavior: 'steer' | 'followUp';
  /** Messages shown before the backend recorded them (a steer or follow-up sent to a background agent): the transcript hides one once its recorded twin is there. */
  optimisticIds: string[];
  dismissedFor: string | undefined;
  /** A composer placeholder set by the view (a background agent's "Message tester"); undefined for the thread's own. */
  placeholderOverride: string | undefined;
  completion: { key: string; items: CompletionItem[]; loading: boolean };
  // ---- thumbs on assistant messages
  feedback: Record<string, FeedbackRating>;
  /** The turn the pointer is over (its user message id): the whole turn shows its usage line and toolbar, not just the piece under the pointer. */
  hotTurn: string | undefined;
  /** Bumped to open the image picker (the ⊕ menu's first entry); the toolbar's file input reacts. */
  pickerRequests: number;
}

export type ChatSessionState = Omit<
  ChatStoreState,
  | 'draft'
  | 'caret'
  | 'caretRequest'
  | 'images'
  | 'chipsByThread'
  | 'behavior'
  | 'dismissedFor'
  | 'completion'
  | 'pickerRequests'
  | 'modelList'
  | 'modelError'
  | 'changedDuringRun'
  | 'feedback'
>;

export const initial: ChatSessionState = {
  reconnects: 0,
  optimisticIds: [],
  placeholderOverride: undefined,
  thinkTimes: {},
  queue: { steering: [], followUp: [] },
  compacting: false,
  retry: undefined,
  runError: undefined,
  lastAborted: false,
  promptActive: undefined,
  statuses: {},
  notices: [],
  hiddenFollowUps: [],
  acceptingFollowUp: undefined,
  agentNames: {},
  liveContextTokens: undefined,
  liveCost: 0,
  liveTokens: 0,
  liveTurns: 0,
  stats: undefined,
  commands: [],
  commandsLoading: false,
  commandsError: undefined,
  hotTurn: undefined,
};

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The text of a user message and its attached images (as base64 attachments). */
export function userContent(message: Message): { text: string; images: { mimeType: string; data: string }[] } {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return { text: content, images: [] };
  const parts = Array.isArray(content)
    ? (content as { type: string; text?: string; source?: { type: string; value?: string; mimeType?: string } }[])
    : [];
  const text = parts.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('');
  const images = parts.flatMap((p) =>
    p.type === 'image' && p.source?.type === 'data' && p.source.value
      ? [{ mimeType: p.source.mimeType ?? 'image/png', data: p.source.value }]
      : [],
  );
  return { text, images };
}

export function lastUserTextOf(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const { text } = userContent(m);
    if (text) return text;
  }
  return undefined;
}

/** The desktop app can quit; a browser tab cannot close itself reliably. */
export function adaptCommand(translate: Translate, command: Command): Command {
  if (command.name === 'quit' && !window.piKit?.quit)
    return { ...command, disabled: true, disabledReason: translate('chat.chatState.closeTheBrowserTabInstead') };
  return command;
}

export type ChatComposerState = Pick<
  ChatStoreState,
  | 'draft'
  | 'caret'
  | 'caretRequest'
  | 'images'
  | 'chipsByThread'
  | 'behavior'
  | 'dismissedFor'
  | 'completion'
  | 'pickerRequests'
>;
export const initialComposer: ChatComposerState = {
  draft: '',
  caret: 0,
  caretRequest: undefined,
  images: [],
  chipsByThread: {},
  behavior: 'steer',
  dismissedFor: undefined,
  completion: { key: '', items: [], loading: false },
  pickerRequests: 0,
};

export type ChatModelsState = Pick<ChatStoreState, 'modelList' | 'modelError' | 'changedDuringRun'>;
export const initialModels: ChatModelsState = {
  modelList: undefined,
  modelError: undefined,
  changedDuringRun: undefined,
};

export type ChatFeedbackState = Pick<ChatStoreState, 'feedback'>;
export const initialFeedback: ChatFeedbackState = {
  feedback: {},
};
