import { type AgentAnswer, type AgentQuestion, type AgentQuestionDialog, agentQuestionId, type PiDialogAnswer, type QuestionKind } from '@pi-kit/protocol';

/** Who answered: the main agent (`agent_reply`), the user (a card, a chip, the panel), the default when the time ran out, or nobody. */
export type AnsweredBy = AgentAnswer['by'];
export type QuestionState = 'pending' | 'routed' | 'answered' | 'expired' | 'cancelled';

/** The record of one question in the agent's `pikit.questions` document: what was asked, where it went, how it ended. */
export interface QuestionRecord {
  id: string;
  /** The `ask` tool call, `toolCallId`. */
  callId: string;
  /** Who asks: the agent's `ask` tool (absent), or the host for a blocked action (`budget`: a limit reached, from builds before 0.8.1). */
  origin?: 'block' | 'budget';
  text: string;
  kind: QuestionKind;
  choices: string[] | null;
  note: string | null;
  forwarded: boolean;
  askedAt: number;
  state: QuestionState;
  answer: string | null;
  by: AnsweredBy | null;
  answeredAt: number | null;
}

export interface AskInput {
  question: string;
  kind: QuestionKind;
  choices?: string[];
}

export function newQuestion(id: string, callId: string, input: AskInput, now: number): QuestionRecord {
  const choices = input.choices?.length ? input.choices : null;
  return { id, callId, text: input.question, kind: input.kind, choices, note: null, forwarded: false, askedAt: now, state: 'pending', answer: null, by: null, answeredAt: null };
}

export const isOpen = (q: QuestionRecord): boolean => q.state === 'pending' || q.state === 'routed';

/** A question the host asks the user on the agent's behalf, already routed: a blocked action. */
export function hostQuestion(id: string, origin: 'block', text: string, choices: string[], now: number): QuestionRecord {
  return { ...newQuestion(id, id, { question: text, kind: 'user', choices }, now), origin, state: 'routed' };
}

/** Why `by` may not answer the question now (the main agent can never answer a `user` question), or undefined. */
export function refusal(q: QuestionRecord, by: AnsweredBy): string | undefined {
  if (!isOpen(q)) return `Question ${q.id} is already ${q.state}.`;
  if (by === 'main' && q.kind === 'user') return `Question ${q.id} is for the user, not the main agent${q.forwarded ? ' (it was forwarded)' : ''}.`;
  return undefined;
}

/** The question once it went where it belongs (to the main agent as a message, or to the user as a card). */
export const routed = (q: QuestionRecord): QuestionRecord => ({ ...q, state: 'routed' });

/** The question answered (`text`), dismissed (`by: 'cancelled'`) or timed out (`by: 'expired'`, or `'default'` with the default as the answer). */
export function settled(q: QuestionRecord, by: AnsweredBy, text: string | null, now: number): QuestionRecord {
  const state: QuestionState = by === 'cancelled' ? 'cancelled' : by === 'expired' ? 'expired' : 'answered';
  return { ...q, state, by, answer: state === 'answered' ? text : null, answeredAt: now };
}

/** The main agent handed the question to the user (`agent_forward`), with a note or not: from then on it is a `user` question. */
export const forwarded = (q: QuestionRecord, note: string | undefined): QuestionRecord => ({ ...q, kind: 'user', forwarded: true, note: note?.trim() || null });

/** The one question an agent waits on (an agent asks one at a time), and its newest answered one. */
export const openQuestion = (questions: Readonly<Record<string, QuestionRecord>>): QuestionRecord | undefined => Object.values(questions).find(isOpen);
export function lastAnswer(questions: Readonly<Record<string, QuestionRecord>>): AgentAnswer | null {
  const done = Object.values(questions).filter((q) => q.answeredAt !== null).sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))[0];
  return done ? { question: done.text, text: done.answer, by: done.by as AnsweredBy, answeredAt: done.answeredAt as number } : null;
}

/** The record as the API shows it. */
export function toQuestion(q: QuestionRecord): AgentQuestion {
  return { id: q.id, text: q.text, kind: q.kind, choices: q.choices, note: q.note, forwarded: q.forwarded, askedAt: q.askedAt, expiresAt: null };
}

/** A user question as a dialog of the thread (the sidebar's chips, the question card): a `select` with its choices, else an `input`. */
export function toDialog(agent: { id: string; name: string }, q: QuestionRecord): AgentQuestionDialog {
  return {
    id: agentQuestionId(agent.id, q.id),
    agentId: agent.id,
    request: {
      method: q.choices ? 'select' : 'input',
      title: q.text,
      ...(q.note ? { message: q.note } : {}),
      ...(q.choices ? { options: q.choices } : {}),
      agent: agent.name,
      toolCallId: q.callId,
    },
  };
}

/** The text of an answer that came as a dialog's payload: the value, or yes/no for a confirmation. */
export const answerText = (payload: PiDialogAnswer): string => ('value' in payload ? payload.value : payload.confirmed ? 'yes' : 'no');

/** What the waiting `ask` tool returns to the agent once its question settled. */
export function answerLine(q: QuestionRecord): string {
  switch (q.by) {
    case 'main':
      return `Answered by main agent: ${q.answer}`;
    case 'user':
      return `Answered by the user: ${q.answer}`;
    case 'default':
      return `No answer within the time; the default applies: ${q.answer}`;
    case 'expired':
      return 'No answer within the time. Decide yourself and go on.';
    default:
      return 'The question was dismissed without an answer. Decide yourself and go on.';
  }
}
