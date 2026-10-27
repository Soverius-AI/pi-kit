import type { AgentRecord } from './agent-extension';

/**
 * What the main agent's session gets from its agents as custom messages pi shows and sends to the model (`pi.sendMessage`):
 * a report, a `main` question, and the receipt of the user's answer. `details.ref` makes the message's attribution id (`<agentId>/<ref>`).
 */
export const REPORT_MESSAGE = 'pikit.agent-report';
export const QUESTION_MESSAGE = 'pikit.agent-question';
export const ANSWER_MESSAGE = 'pikit.agent-answer';
export interface ReportMessage {
  customType: typeof REPORT_MESSAGE | typeof QUESTION_MESSAGE | typeof ANSWER_MESSAGE;
  content: string;
  display: true;
  details: { agentId: string; name: string; ref: string; reportId?: string; questionId?: string };
}

/**
 * What the service needs of the threads: where one works (`ThreadsService.cwdOf`: its worktree while it has one, else the project), resolved at
 * every call, and a way to hand its main agent a message (the session, opened if it is not). A token, so a process without Nest can build the service.
 */
export const THREAD_HOST = Symbol('THREAD_HOST');
export interface ThreadHost {
  cwdOf(threadId: string): string;
  /** Hands the main agent a message, which starts a turn (a steer while it runs); resolves once handed over, not when the turn ends. */
  deliver(threadId: string, message: ReportMessage): Promise<void>;
  /** Why background agents may not run in the thread's project (the folder is not trusted, or the project switched them off); undefined when they may. */
  allowed(threadId: string): Promise<string | undefined>;
  /** A worktree of the thread's project for an `isolated` agent, and its removal when the agent is deleted. */
  isolate(threadId: string, agentId: string, name: string): Promise<NonNullable<AgentRecord['worktree']>>;
  discard(worktree: NonNullable<AgentRecord['worktree']>): Promise<void>;
}
