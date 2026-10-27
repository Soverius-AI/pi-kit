import { EventType, type BaseEvent, verifyEvents } from '@ag-ui/client';
import { createMapContext, mapEvent, type PiEvent } from '@pi-kit/pi-adapter';
import { firstValueFrom, from, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { subagentEnvelope } from './pi-agent';

/** A run of the main agent that spawns an agent and later gets its report, mapped as `PiAgent` maps it. */
function run(): BaseEvent[] {
  const ctx = createMapContext({ threadId: 't1', runId: 'r1', skipUserMessages: 0 });
  const map = (event: PiEvent) => subagentEnvelope(event, mapEvent(event, ctx));
  const spawnEnd: PiEvent = { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'agent_spawn', isError: false, result: { content: [{ type: 'text', text: '{"agentId":"7"}' }], details: { agentId: '7', name: 'tester', role: 'tests' } } };
  const report: PiEvent = { type: 'message_end', message: { role: 'custom', customType: 'pikit.agent-report', display: true, content: [{ type: 'text', text: 'Report from agent "tester": Tests pass.' }], details: { agentId: '7', name: 'tester', reportId: 'rep-1' } } };
  return [
    { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent,
    ...map({ type: 'message_start', message: { role: 'assistant' } }),
    ...map({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'agent_spawn', args: { name: 'tester' } }),
    ...map(spawnEnd),
    ...map(report),
    ...map({ type: 'agent_settled', aborted: false }),
  ];
}

describe('subagentEnvelope', () => {
  it('wraps the finished agent_spawn call and an attributed report, each under its own id, and the verifier accepts the run', async () => {
    const events = run();
    const types = events.map((e) => e.type);
    const started = events.filter((e) => e.type === EventType.SUBAGENT_STARTED) as unknown as { subagentRunId: string; name: string; parentToolCallId?: string }[];
    expect(started.map((e) => e.subagentRunId)).toEqual(['7/spawn', '7/rep-1']);
    expect(started[0]).toMatchObject({ name: 'tester', parentToolCallId: 'c1' });
    expect(types.filter((t) => t === EventType.SUBAGENT_FINISHED)).toHaveLength(2);
    const text = events.find((e) => e.type === EventType.TEXT_MESSAGE_START) as unknown as { role: string; subagentRunId?: string };
    expect(text).toMatchObject({ role: 'user', subagentRunId: '7/rep-1' });
    // The spawn's tool result sits between its envelope's start and end.
    const spawnStart = types.indexOf(EventType.SUBAGENT_STARTED);
    expect(types.slice(spawnStart, spawnStart + 4)).toEqual([EventType.SUBAGENT_STARTED, EventType.ACTIVITY_SNAPSHOT, EventType.TOOL_CALL_RESULT, EventType.SUBAGENT_FINISHED]);
    await expect(firstValueFrom(from(events).pipe(verifyEvents(false), toArray()))).resolves.toHaveLength(events.length);
  });

  it('leaves other events alone, including a failed spawn and other custom messages', () => {
    const ctx = createMapContext({ threadId: 't1', runId: 'r1', skipUserMessages: 0 });
    const failed: PiEvent = { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'agent_spawn', isError: true, result: { content: [{ type: 'text', text: 'no' }] } };
    expect(subagentEnvelope(failed, mapEvent(failed, ctx)).map((e) => e.type)).not.toContain(EventType.SUBAGENT_STARTED);
    const note: PiEvent = { type: 'message_end', message: { role: 'custom', customType: 'pi-kit:coordination', display: true, content: 'x' } };
    expect(subagentEnvelope(note, mapEvent(note, ctx)).map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END]);
  });
});
