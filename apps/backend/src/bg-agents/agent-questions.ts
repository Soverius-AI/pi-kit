import { Logger } from '@nestjs/common';
import { copyJson } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, Harness as DurableHarness } from '@earendil-works/pi-durable';
import { type AgentAnswer, type AgentQuestion, type AgentQuestionDialog, parseAgentQuestionId, type PiDialogAnswer } from '@pi-kit/protocol';
import { QuestionsDoc } from './agent-extension';
import type { BgAgentsRepository } from './bg-agents.repository';
import { type AnsweredBy, answerText, forwarded, hostQuestion, isOpen, lastAnswer, openQuestion, type QuestionRecord, refusal, routed, settled, toDialog, toQuestion } from './questions';
import { ANSWER_MESSAGE, QUESTION_MESSAGE, type ThreadHost } from './thread-host';

const ctx = BACKGROUND_CONTEXT;
const conversationId = (id: string): ConversationId => Number(id) as ConversationId;

/** Owns durable question transitions, delivery, and waiting for one host. */
export class AgentQuestions {
  private readonly logger = new Logger(AgentQuestions.name);
  private readonly cache = new Map<string, Record<string, QuestionRecord>>();

  constructor(
    private readonly harness: () => DurableHarness,
    private readonly agents: BgAgentsRepository,
    private readonly threads: Pick<ThreadHost, 'deliver'>,
    private readonly changed: (id: string) => void,
  ) {}

  current(id: string): AgentQuestion | null {
    const q = openQuestion(this.cache.get(id) ?? {});
    return q ? toQuestion(q) : null;
  }

  lastAnswer(id: string): AgentAnswer | null {
    return lastAnswer(this.cache.get(id) ?? {});
  }

  async recover(id: string): Promise<void> {
    await this.questionsOf(id);
    this.changed(id);
  }

  /** The `ask` tool committed a question (or ran again after a restart): a `main` question goes to the main agent once. */
  async asked(id: string, questionId: string): Promise<void> {
    const row = this.agents.get(id);
    const q = (await this.questionsOf(id))[questionId];
    if (!row || !q || !isOpen(q)) return;
    if (q.state === 'pending') {
      // Routed first: the answer can arrive while the message is still being delivered, and a retry must not deliver twice.
      await this.changeQuestion(id, q.id, (current) => current && !isOpen(current) ? current : routed(current ?? q));
      if (q.kind === 'main') await this.threads.deliver(row.threadId, { customType: QUESTION_MESSAGE, display: true, details: { agentId: id, name: row.name, ref: questionId, questionId }, content: `Question from agent "${row.name}" (agent ${id}, question ${questionId}): ${q.text}${q.choices ? ` Choices: ${q.choices.join(' | ')}.` : ''} Answer with agent_reply, or agent_forward if the user must decide.` });
    }
    this.changed(id);
  }

  /** `agent_forward`: the question is the user's from now on; it shows in the thread and the panel, and "Needs you" counts it. */
  async forward(id: string, questionId: string, note?: string): Promise<void> {
    await this.changeQuestion(id, questionId, (q) => {
      if (!q) throw new Error(`Agent ${id} has no question ${questionId}.`);
      const block = refusal(q, 'main');
      if (block) throw new Error(block);
      return forwarded(q, note);
    });
    this.changed(id);
  }

  /** The user's answer as an AG-UI resume carries it (the thread's card, a sidebar chip): false when the interrupt is not an agent's question. */
  async answerInterrupt(interruptId: string, answer: PiDialogAnswer | 'cancelled'): Promise<boolean> {
    const parsed = parseAgentQuestionId(interruptId);
    if (!parsed) return false;
    await this.answer(parsed.agentId, parsed.questionId, answer === 'cancelled' ? 'cancelled' : 'user', answer === 'cancelled' ? null : answerText(answer));
    return true;
  }

  /** Settles a question: the record, the waiting tool (through the document), the panel, and the main agent's one-line receipt of a user's answer (a turn, so it can act on it). */
  async answer(id: string, questionId: string, by: AnsweredBy, text: string | null): Promise<void> {
    const row = this.agents.get(id);
    if (!row) throw new Error(`Agent ${id} has no question ${questionId}.`);
    const done = await this.changeQuestion(id, questionId, (q) => {
      if (!q) throw new Error(`Agent ${id} has no question ${questionId}.`);
      const block = refusal(q, by);
      if (block) throw new Error(block);
      return settled(q, by, text, Date.now());
    });
    this.changed(id);
    if (by === 'user' || by === 'cancelled') {
      const content = by === 'user' ? `The user answered agent "${row.name}"'s question "${done.text}": ${text}` : `The user dismissed agent "${row.name}"'s question "${done.text}" without an answer.`;
      await this.threads.deliver(row.threadId, { customType: ANSWER_MESSAGE, content, display: true, details: { agentId: id, name: row.name, ref: `${questionId}/answer`, questionId } }).catch((error: unknown) => this.logger.debug(`No receipt for ${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * A question the host asks on the agent's behalf (a blocked action): the record is written once by its
   * id (a rerun after a restart finds it), and the caller waits on the document until the user answers; dismissed or stopped is null.
   */
  async askUser(id: string, questionId: string, origin: 'block', text: string, choices: string[], signal: AbortSignal | undefined): Promise<string | null> {
    const existing = (await this.questionsOf(id))[questionId];
    if (!existing) {
      await this.changeQuestion(id, questionId, (current) => current ?? hostQuestion(questionId, origin, text, choices, Date.now()));
      this.changed(id);
    }
    const done = await this.settledQuestion(id, questionId, signal);
    return done?.state === 'answered' ? done.answer : null;
  }

  /** The record once it settled, watched on the document so it is seen from any process. */
  private async settledQuestion(id: string, questionId: string, signal: AbortSignal | undefined): Promise<QuestionRecord | undefined> {
    const current = this.cache.get(id)?.[questionId];
    if (current && !isOpen(current)) return current;
    const watch = await this.harness().watchDoc(QuestionsDoc, conversationId(id), ctx);
    if (!watch) return undefined;
    const settledOf = (state: { questions: Record<string, QuestionRecord> } | null | undefined): QuestionRecord | undefined => {
      const q = state?.questions[questionId];
      return q && !isOpen(q) ? q : undefined;
    };
    const done = await new Promise<QuestionRecord | undefined>((resolve) => {
      watch.start(async (value) => void (settledOf(value) && resolve(settledOf(value))));
      signal?.addEventListener('abort', () => resolve(undefined), { once: true });
      void this.harness().snapshot(QuestionsDoc, conversationId(id), ctx).then((state) => void (settledOf(state) && resolve(settledOf(state))));
    });
    await watch.stop();
    return done;
  }

  /** The open questions of the thread's agents the user has to answer, as dialogs of the thread (the status channel, "Needs you"). */
  userQuestions(threadId: string): AgentQuestionDialog[] {
    const out: AgentQuestionDialog[] = [];
    for (const row of this.agents.byThread(threadId)) {
      if (row.status !== 'active' && row.status !== 'blocked') continue;
      const q = openQuestion(this.cache.get(row.id) ?? {});
      if (q?.kind === 'user') out.push(toDialog(row, q));
    }
    return out;
  }

  private async questionsOf(id: string): Promise<Record<string, QuestionRecord>> {
    if (!this.agents.get(id)) throw new Error(`Agent ${id} does not exist.`);
    const doc = await this.harness().snapshot(QuestionsDoc, conversationId(id), ctx);
    const questions = doc?.questions ?? {};
    this.cache.set(id, questions);
    return questions;
  }

  /** Validate and apply each transition against the durable record in the same transaction. */
  private async changeQuestion(id: string, questionId: string, update: (current: QuestionRecord | undefined) => QuestionRecord): Promise<QuestionRecord> {
    const written = await this.harness().commit(async (tx) => {
      const doc = await tx.doc(QuestionsDoc, conversationId(id));
      // Transaction draft handles expire at commit, including arrays retained by a shallow object spread.
      const next = copyJson(update(doc.questions[questionId])) as unknown as QuestionRecord;
      doc.questions = { ...doc.questions, [questionId]: next };
      return next;
    }, ctx);
    this.cache.set(id, { ...(this.cache.get(id) ?? {}), [questionId]: written });
    return written;
  }
}
