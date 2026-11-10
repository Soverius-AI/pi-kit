import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType } from '@ag-ui/client';
import type { Op } from '@earendil-works/chord/delta';
import type { EntryRecord, LiveState, TranscriptView, WatchEnd } from '@earendil-works/pi-durable';
import { AGENT_LIVE_SYNC_RUN, REPLAY_CURSOR_HEADER, REPLAY_CURSOR_METADATA } from '@pi-kit/protocol';
import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseEvent } from '@ag-ui/client';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import type { AgentViewStream } from './agent-events';
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

/** A view of the whole transcript and `pi.live`, as `AgentViews` hands it on. */
const view = (entries: EntryRecord[] = [], live: LiveState = {}, docs: Record<string, unknown> = {}): TranscriptView =>
  ({
    conversation: {} as never,
    items: entries.map((entry) => ({ kind: 'entry', entry })),
    docs: { ...docs, 'pi.live': live },
  }) as TranscriptView;

/** A durable view stream a test feeds by hand. */
function stream(first = view()) {
  let listener: Parameters<AgentViewStream['start']>[0] | undefined;
  return {
    view: first,
    timing: {},
    start: (fn: Parameters<AgentViewStream['start']>[0]): void => void (listener = fn),
    stop: vi.fn(async (): Promise<WatchEnd> => ({ kind: 'stopped' }) as const),
    emit: (next: TranscriptView, ops: Op[] = [['s', ['docs', 'pi.live'], next.docs['pi.live'] ?? {}]]) =>
      listener?.(next, ops, {}),
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
    const input = {
      id: 1,
      conversationId: 7,
      kind: 'pi.user',
      model: [{ role: 'user', content: 'go', timestamp: 1 }],
    } as never;
    await s.emit(view([input], { run: { taskId: 1, inputs: [1], turns: 0 } } as unknown as LiveState));
    expect(runner.isRunning('7')).toBe(true);
    await s.emit(view([input]));
    await runner.detach('7');
    const events = await live;
    expect(events.slice(0, 5).map((e) => e.type)).toEqual([
      EventType.CUSTOM,
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1);
    expect(
      events.every(
        (e) =>
          (e.metadata as Record<string, unknown> | undefined)?.[REPLAY_CURSOR_METADATA] !== undefined ||
          e.type === EventType.CUSTOM,
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(s.stop).toHaveBeenCalled();
    expect(runner.isRunning('7')).toBe(false);
    // Detached: the log still replays, nothing follows.
    const again = await firstValueFrom(runner.connect({ threadId: '7', agentId: 'pi-bg' } as never).pipe(toArray()));
    expect(again.filter((e) => e.type === EventType.RUN_STARTED)).toHaveLength(2);
  });

  it('keeps a live state change made while the agent is idle in its log, in a run of its own, counts it and tells, so a client joins and a replay ends in it', async () => {
    const s = stream();
    const told = vi.fn();
    runner.onLive = told;
    runner.attach('7', s);
    expect(runner.liveSyncsOf('7')).toBe(0);
    // A client that saw the attachment and left: the agent is idle, so it is not connected when the change comes.
    const seen: BaseEvent[] = [];
    runner
      .connect({ threadId: '7', agentId: 'pi-bg' } as never)
      .subscribe((event) => seen.push(event))
      .unsubscribe();
    const cursor = (seen.at(-1)?.metadata as Record<string, string>)[REPLAY_CURSOR_METADATA];
    const inbox = { items: [{ id: 5, mode: 'followUp' }] };
    await s.emit(view([], {}, { 'pi.inbox': inbox }), [['s', ['docs', 'pi.inbox'], inbox]]);
    expect(runner.liveSyncsOf('7')).toBe(1);
    expect(told).toHaveBeenCalledWith('7');
    // Told, it joins again from its cursor and gets the sync run from the log.
    const joined: BaseEvent[] = [];
    runner
      .connect({ threadId: '7', agentId: 'pi-bg', headers: { [REPLAY_CURSOR_HEADER]: cursor } } as never)
      .subscribe((event) => joined.push(event))
      .unsubscribe();
    expect(joined.map((event) => event.type)).toEqual([
      EventType.CUSTOM,
      EventType.RUN_STARTED,
      EventType.ACTIVITY_DELTA,
      EventType.RUN_FINISHED,
    ]);
    const log = new EventLogRepository(database);
    const stored = log.read('7').map(({ event }) => event as { type: EventType; runId?: string; patch?: unknown });
    expect(stored.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
      EventType.RUN_STARTED,
      EventType.ACTIVITY_DELTA,
      EventType.RUN_FINISHED,
    ]);
    expect(stored[4].runId?.startsWith(AGENT_LIVE_SYNC_RUN)).toBe(true);
    expect(stored[5].patch).toEqual([{ op: 'add', path: '/docs/pi.inbox', value: inbox }]);
    // A later run's end supersedes it: its activity snapshot, which a compaction keeps, holds the change.
    const run = { run: { taskId: 1, inputs: [1], turns: 0 } } as unknown as LiveState;
    await s.emit(view([], run, { 'pi.inbox': inbox }), [['s', ['docs', 'pi.live', 'run'], run.run as never]]);
    await s.emit(view([], {}, { 'pi.inbox': inbox }), [['d', ['docs', 'pi.live', 'run']]]);
    const replay = log.read('7').map(({ event }) => event as { type: EventType; content?: unknown });
    expect(replay.at(-2)).toMatchObject({
      type: EventType.ACTIVITY_SNAPSHOT,
      content: { docs: { 'pi.inbox': inbox } },
    });
    expect(replay.filter((event) => event.type === EventType.ACTIVITY_DELTA)).toEqual([]);
    await runner.detach('7');
  });

  it('a run of pi-bg is a message to the agent, a stop ends it', async () => {
    const actions: BgAgentActions = { send: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    runner.useActions(actions);
    runner.attach('7', stream());
    const events = await firstValueFrom(
      runner
        .run({
          threadId: '7',
          input: {
            threadId: '7',
            runId: 'r1',
            messages: [{ id: 'm', role: 'user', content: 'Also cover greet.' }],
            forwardedProps: { streamingBehavior: 'steer' },
          },
        } as never)
        .pipe(toArray()),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(actions.send).toHaveBeenCalledWith('7', 'Also cover greet.', 'steer', 'message:r1');
    expect(await runner.stop({ threadId: '7' } as never)).toBe(true);
    expect(actions.stop).toHaveBeenCalledWith('7');
    expect(await runner.stop({ threadId: 'unknown' } as never)).toBe(false);
  });
});
