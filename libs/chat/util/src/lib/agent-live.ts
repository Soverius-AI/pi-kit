import type { Message } from '@ag-ui/core';
import type { Translate } from '@pi-kit/i18n';
import { activityId, PiAgentLiveContentSchema, type PiLiveState } from '@pi-kit/protocol';
import { formatDuration } from '@pi-kit/ui';

export type AgentLiveTool = NonNullable<PiLiveState['tools']>[number];
export type AgentLiveNestedTool = NonNullable<PiLiveState['nestedTools']>[number];
export interface AgentLiveTiming {
  startedAt?: number;
  endedAt?: number;
}

export interface AgentLivePin {
  messages: Message[];
  live: PiLiveState | undefined;
  tools: ReadonlyMap<string, AgentLiveTool>;
  nested: ReadonlyMap<string, readonly AgentLiveNestedTool[]>;
  timing: ReadonlyMap<string, AgentLiveTiming>;
}

export interface AgentLiveItem {
  id: string;
  name: string;
  state: 'running' | 'done' | 'error';
  target?: string;
  sub?: string;
  stat?: string;
  output?: string;
  note?: string;
  children?: AgentLiveItem[];
}

export class AgentLiveState {
  static pin(messages: readonly Message[], agentId: string | undefined): AgentLivePin {
    const isLive = (m: Message) => m.role === 'activity' && m.activityType === 'pi.agent_live';
    const activity = agentId
      ? messages.filter((m) => isLive(m) && m.id === activityId.agentLive(agentId)).at(-1)
      : undefined;
    const committed = messages.filter((m) => !isLive(m));
    const parsed = PiAgentLiveContentSchema.safeParse(activity?.content);
    const state = parsed.success ? parsed.data.docs['pi.live'] : undefined;
    if (!parsed.success || !state)
      return { messages: committed, live: undefined, tools: new Map(), nested: new Map(), timing: new Map() };
    const rows = new Set(
      committed.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((call) => call.id) : [])),
    );
    const nested = new Map<string, AgentLiveNestedTool[]>();
    for (const tool of state.nestedTools ?? [])
      nested.set(tool.parentCallId, [...(nested.get(tool.parentCallId) ?? []), tool]);
    const live: PiLiveState = { ...state, tools: state.tools?.filter((tool) => !rows.has(tool.callId)) };
    const idle =
      !live.run &&
      !live.generation &&
      !live.tools?.length &&
      !live.compactions?.length &&
      !live.compactionFailure &&
      !live.runFailure;
    return {
      messages: committed,
      live: idle ? undefined : live,
      tools: new Map(
        (state.tools ?? []).filter((tool) => rows.has(tool.callId)).map((tool) => [tool.callId, tool] as const),
      ),
      nested,
      timing: new Map(Object.entries(parsed.data.timing ?? {})),
    };
  }

  static running(tool: AgentLiveTool): boolean {
    return tool.status !== 'done';
  }

  static progress(tool: AgentLiveTool): string | undefined {
    return tool.output
      ?.split('\n')
      .filter((line) => line.trim())
      .at(-1)
      ?.trim();
  }

  static note(translate: Translate, tool: AgentLiveTool): string | undefined {
    if (tool.droppedLines) return translate('chat.agentLive.droppedLines', { value1: tool.droppedLines });
    if (tool.droppedBytes) return translate('chat.agentLive.droppedBytes', { value1: tool.droppedBytes });
    return undefined;
  }

  static elapsed(timing: AgentLiveTiming | undefined, running: boolean, now: number): number | undefined {
    if (timing?.startedAt === undefined) return undefined;
    const end = timing.endedAt ?? (running ? now : undefined);
    return end === undefined ? undefined : Math.max(0, end - timing.startedAt);
  }

  static items(
    translate: Translate,
    tools: readonly (AgentLiveTool | AgentLiveNestedTool)[],
    pin: Pick<AgentLivePin, 'nested' | 'timing'>,
    now: number,
  ): AgentLiveItem[] {
    return tools.map((tool) => {
      const { summary, arguments: args } = tool as Partial<AgentLiveNestedTool>;
      const running = AgentLiveState.running(tool);
      const failed = !running && summary?.isError === true;
      const elapsed = AgentLiveState.elapsed(pin.timing.get(tool.callId), running, now) ?? summary?.durationMs;
      const children = AgentLiveState.items(translate, pin.nested.get(tool.callId) ?? [], pin, now);
      return {
        id: tool.callId,
        name: tool.name,
        state: running ? 'running' : failed ? 'error' : 'done',
        target: args ? AgentLiveState.hint(args) : undefined,
        sub: running
          ? [translate(`chat.agentLive.${tool.status}`), elapsed !== undefined ? formatDuration(elapsed) : undefined]
              .filter(Boolean)
              .join(', ')
          : failed
            ? (summary?.error ?? translate('chat.agentLive.failed'))
            : undefined,
        stat: !running && elapsed !== undefined && elapsed >= 1000 ? formatDuration(elapsed) : undefined,
        output: tool.output,
        note: AgentLiveState.note(translate, tool),
        ...(children.length ? { children } : {}),
      };
    });
  }

  private static hint(args: Record<string, unknown>): string {
    for (const key of ['command', 'path', 'file', 'pattern', 'query', 'url', 'name']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, 120);
    }
    const json = JSON.stringify(args);
    return json === '{}' ? '' : json.slice(0, 120);
  }
}
