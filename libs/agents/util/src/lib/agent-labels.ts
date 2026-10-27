import type { AgentPermission, AgentTokens, BgAgent } from '@pi-kit/protocol';
import { compactNumber } from '@pi-kit/ui';

/** The i18n key under `agents.agentsPanel` that says what an agent does or how it ended, and the value a parameterized one takes. */
export function agentStateKey(agent: BgAgent): { key: string; value?: string } {
  if (agent.status === 'blocked') return { key: 'held', value: agent.blocked === 'cleanup' ? 'heldCleanup' : 'heldCrashLoop' };
  if (agent.status !== 'active') return { key: agent.status };
  if (agent.question) return { key: agent.question.kind === 'user' ? 'waitingForYou' : 'waitingForMain' };
  if (agent.activity === 'tool' && agent.tool) return { key: 'runningTool', value: agent.tool };
  return { key: agent.activity === 'running' ? 'running' : 'waiting' };
}

/** The badge class of an agent's state: daisyUI's semantic colours only. */
export function agentBadge(agent: BgAgent): string {
  switch (agent.status) {
    case 'active':
      return agent.question?.kind === 'user' ? 'badge-warning' : agent.activity === 'idle' ? 'badge-ghost' : 'badge-info';
    case 'blocked':
      return 'badge-warning';
    case 'done':
      return 'badge-success';
    case 'failed':
      return 'badge-error';
    default:
      return 'badge-ghost';
  }
}

/** How long an agent ran, in milliseconds: until it finished, else until now. */
export function agentDurationMs(agent: BgAgent, now: number): number {
  return Math.max(0, (agent.finishedAt ?? now) - agent.createdAt);
}

/** An agent's tokens for the card: input and output compact ("12.3k"), and what was read from the cache. */
export function agentTokens(tokens: AgentTokens | undefined): { input: string; output: string; cached: string } {
  const t = tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { input: compactNumber(t.input + t.cacheRead), output: compactNumber(t.output), cached: compactNumber(t.cacheRead) };
}

/** How full an active agent's context is, 0–100, or null when its window is not known or it has not answered yet. */
export function agentContextPercent(agent: Pick<BgAgent, 'context'>): number | null {
  const context = agent.context;
  return context && context.window ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : null;
}

/** The tools an agent's permission allows: `bash-read-only` stands for bash limited to commands that read. */
export function agentAllowedTools(permission: AgentPermission): string[] {
  return permission === 'read-only' ? ['read', 'bash-read-only', 'ask', 'report'] : ['read', 'write', 'edit', 'bash', 'ask', 'report'];
}

/** The agents of a thread in the two lists of the panel: the ones still at work, and History, newest first. */
export function splitAgents(agents: readonly BgAgent[]): { active: BgAgent[]; history: BgAgent[] } {
  return {
    active: agents.filter((agent) => agent.status === 'active' || agent.status === 'blocked'),
    history: agents.filter((agent) => agent.status !== 'active' && agent.status !== 'blocked').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
  };
}
