import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType } from '@ag-ui/client';
import type { AgentEvent, SnapshotEvent, WatchEnd } from '@earendil-works/pi-durable';
import { REPLAY_CURSOR_METADATA } from '@pi-kit/protocol';
import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import type { DurableEventStream } from './agent-events';
import { BgAgentRunner, type BgAgentActions } from './bg-agent-runner';

let dir: string;
let database: DatabaseService;
let runner: BgAgentRunner;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-bg-runner-'));
  database = new DatabaseService({ dataDir: dir });
  runner = new BgAgentRunner(new EventLogRepository(database));
});
afterEach(() => {
  database.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

/** A durable event stream a test feeds by hand. */
function stream(snapshot: Partial<SnapshotEvent> = {}) {
  let listener: Parameters<DurableEventStream['start']>[0] | undefined;
  return {
    snapshot: { type: 'snapshot', entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...snapshot } as SnapshotEvent,
    start: (fn: Parameters<DurableEventStream['start']>[0]): void => void (listener = fn),
    stop: vi.fn(async (): Promise<WatchEnd> => ({ reason: 'closed' }) as unknown as WatchEnd),
    emit: (events: AgentEvent[]) => listener?.(events, {} as never),
  };
}

describe('BgAgentRunner (the AG-UI agent pi-bg)', () => {
  it('stores a followed agent’s events under its id, replays them with cursors, and follows the live feed', async () => {
    const s = stream();
    runner.attach('7', s);
    expect(runner.owns('7')).toBe(true);
    expect(runner.owns('t1')).toBe(false);
    // A connection stays open while the agent is followed: what is stored comes first, the live feed after it.
    const live = firstValueFrom(runner.connect({ threadId: '7', agentId: 'pi-bg' } as never).pipe(toArray()));
    await s.emit([{ type: 'run_start', inputs: [] }, { type: 'message_end', entry: { id: 1, conversationId: 7, kind: 'pi.user', model: [{ role: 'user', content: 'go', timestamp: 1 }] } as never }]);
    expect(runner.isRunning('7')).toBe(true);
    await s.emit([{ type: 'run_end', inputs: [] }]);
    await runner.detach('7');
    const events = await live;
    expect(events.slice(0, 4).map((e) => e.type)).toEqual([EventType.CUSTOM, EventType.RUN_STARTED, EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
    expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1);
    expect(events.every((e) => (e.metadata as Record<string, unknown> | undefined)?.[REPLAY_CURSOR_METADATA] !== undefined || e.type === EventType.CUSTOM)).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(s.stop).toHaveBeenCalled();
    expect(runner.isRunning('7')).toBe(false);
    // Detached: the log still replays, nothing follows.
    const again = await firstValueFrom(runner.connect({ threadId: '7', agentId: 'pi-bg' } as never).pipe(toArray()));
    expect(again.filter((e) => e.type === EventType.RUN_STARTED)).toHaveLength(2);
  });

  it('a run of pi-bg is a message to the agent, a stop ends it', async () => {
    const actions: BgAgentActions = { send: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    runner.useActions(actions);
    runner.attach('7', stream());
    const events = await firstValueFrom(runner.run({ threadId: '7', input: { threadId: '7', runId: 'r1', messages: [{ id: 'm', role: 'user', content: 'Also cover greet.' }], forwardedProps: { streamingBehavior: 'steer' } } } as never).pipe(toArray()));
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(actions.send).toHaveBeenCalledWith('7', 'Also cover greet.', 'steer', 'message:r1');
    expect(await runner.stop({ threadId: '7' } as never)).toBe(true);
    expect(actions.stop).toHaveBeenCalledWith('7');
    expect(await runner.stop({ threadId: 'unknown' } as never)).toBe(false);
  });
});
