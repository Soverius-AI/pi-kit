import { z } from 'zod';
import { PiDialogRequestSchema } from './interrupts';

/**
 * The background agents of a thread: `GET /api/threads/:id/agents` and the panel's actions. An agent's id is its
 * pi-durable conversation id; the transcript of an agent is the AG-UI agent `pi-bg` with that id as thread id.
 */
export const AgentPermissionSchema = z.enum(['read-only', 'edit', 'isolated']);
export type AgentPermission = z.infer<typeof AgentPermissionSchema>;

/** `active`: running or waiting in the durable store. `blocked`: held until the user decides (`blocked` says why). */
export const AgentStatusSchema = z.enum(['active', 'blocked', 'done', 'failed', 'stopped']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** `main`: the main agent answers (or forwards). `user`: only the user can (preferences, credentials, anything destructive). */
export const QuestionKindSchema = z.enum(['main', 'user']);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

/** A question an agent asked and still waits on, as the panel and the thread show it. */
export const AgentQuestionSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    kind: QuestionKindSchema,
    choices: z.array(z.string()).nullable(),
    /** The main agent's note when it forwarded the question to the user. */
    note: z.string().nullable(),
    /** True once the main agent forwarded it: it was a `main` question the user now answers. */
    forwarded: z.boolean(),
    askedAt: z.number(),
    /** Always null: background-agent questions stay open until answered or cancelled. Retained for existing API clients. */
    expiresAt: z.number().nullable(),
  })
  .meta({ id: 'AgentQuestion' });
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;

/** How an agent's last question was answered: by the main agent (Override sends the user's own answer as a steer), by the user, by the default, or not at all. */
export const AgentAnswerSchema = z
  .object({ question: z.string(), text: z.string().nullable(), by: z.enum(['main', 'user', 'default', 'cancelled', 'expired']), answeredAt: z.number() })
  .meta({ id: 'AgentAnswer' });
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

/** Tokens an agent's model requests used so far: the sum over its models, as pi-ai counts them. */
export const AgentTokensSchema = z.object({ input: z.number().int(), output: z.number().int(), cacheRead: z.number().int(), cacheWrite: z.number().int() }).meta({ id: 'AgentTokens' });
export type AgentTokens = z.infer<typeof AgentTokensSchema>;
export const BgAgentSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    /** Short, unique in the thread: `tester`, `reviewer`. */
    name: z.string(),
    role: z.string(),
    /** `provider/modelId`; null for the host's default. */
    model: z.string().nullable(),
    permission: AgentPermissionSchema,
    brief: z.string(),
    status: AgentStatusSchema,
    /** Why a `blocked` agent waits: a command of it may still run from before a crash (`cleanup`), or it restarted three times in ten minutes (`crash-loop`). */
    blocked: z.enum(['cleanup', 'crash-loop']).nullable(),
    createdAt: z.number(),
    finishedAt: z.number().nullable(),
    /** Spend so far, in the model's currency; refreshed before every model request and when the agent ends. */
    cost: z.number(),
    tokens: AgentTokensSchema,
    /** Its report, once it reported. */
    report: z.string().nullable(),
    /** What an active agent does right now: generating, running a tool (`tool` names it), or idle between runs. */
    activity: z.enum(['idle', 'running', 'tool']),
    tool: z.string().nullable(),
    /** The context of an active agent after its last model response (tokens, and the model's window when pi knows it); null while idle or before the first response. */
    context: z.object({ tokens: z.number().int(), window: z.number().int().nullable() }).nullable(),
    /** The question it waits on, if any. */
    question: AgentQuestionSchema.nullable(),
    /** Its last answered question, for "answered by main agent" and Override. */
    answered: AgentAnswerSchema.nullable(),
    /** Model requests so far. */
    turns: z.number().int(),
    /** The folder of an `isolated` agent's own worktree; null when it works in the thread's folder. */
    worktree: z.string().nullable(),
  })
  .meta({ id: 'BgAgent' });
export type BgAgent = z.infer<typeof BgAgentSchema>;

/** `POST /api/threads/:id/agents/:agent/message`: more instructions for a running agent. */
export const AgentMessageBodySchema = z.object({ text: z.string().min(1), mode: z.enum(['steer', 'followUp']).default('followUp') }).meta({ id: 'AgentMessageBody' });
export type AgentMessageBody = z.infer<typeof AgentMessageBodySchema>;

/** `POST /api/threads/:id/agents/:agent/answer`: the user's answer to one of the agent's questions, or its dismissal. */
export const AgentAnswerBodySchema = z.object({ question: z.string().min(1), text: z.string().optional(), cancelled: z.boolean().optional() }).meta({ id: 'AgentAnswerBody' });
export type AgentAnswerBody = z.infer<typeof AgentAnswerBodySchema>;

/** A user question's id as the thread state and the AG-UI resume carry it: `agent-question:<agentId>:<questionId>`. */
export const agentQuestionId = (agentId: string, questionId: string): string => `agent-question:${agentId}:${questionId}`;
export function parseAgentQuestionId(id: string | undefined): { agentId: string; questionId: string } | undefined {
  const match = /^agent-question:([^:]+):(.+)$/.exec(id ?? '');
  return match ? { agentId: match[1], questionId: match[2] } : undefined;
}

/** A user question as the thread's "Needs you" strip and the question card see it: a dialog like pi's own, attributed to the agent. */
export const AgentQuestionDialogSchema = z.object({ id: z.string(), agentId: z.string(), request: PiDialogRequestSchema });
export type AgentQuestionDialog = z.infer<typeof AgentQuestionDialogSchema>;
