import { EventType, type BaseEvent } from '@ag-ui/core';
import type { RoomLive as RoomLiveMessage, RoomStreamLine } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomsRepository } from '../db/rooms.repository';
import { RoomBus } from './room-bus';
import { RoomLive } from './room-live';

describe('what a participant writes, live', () => {
  let bus: RoomBus;
  let live: RoomLive;
  let sent: RoomLiveMessage[];
  const event = (type: EventType, more: Record<string, unknown> = {}) => ({ type, ...more }) as BaseEvent;
  const text = (delta: string) => event(EventType.TEXT_MESSAGE_CONTENT, { delta });

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new RoomBus({} as RoomsRepository);
    live = new RoomLive(bus);
    sent = [];
    bus.subscribe('room', (line: RoomStreamLine) => {
      if (line.type === 'live') sent.push(line.live);
    });
  });

  afterEach(() => vi.useRealTimers());

  it('sends the text in pieces, a few times a second, names the tool being called and ends the turn', () => {
    const turn = live.turn({ roomId: 'room', actor: 'consultant', role: 'security' });
    turn.observe(event(EventType.TEXT_MESSAGE_START));
    turn.observe(text('Two pull '));
    turn.observe(text('requests'));
    expect(sent).toEqual([expect.objectContaining({ actor: 'consultant', role: 'security', text: '', done: false })]);
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({
      actor: 'consultant',
      role: 'security',
      text: 'Two pull requests',
      reset: true,
    });
    turn.observe(text(' wait.'));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ text: ' wait.', reset: false, done: false });
    expect(live.snapshot('room')).toEqual([expect.objectContaining({ text: 'Two pull requests wait.', reset: true })]);

    turn.observe(event(EventType.TOOL_CALL_START, { toolCallName: 'room_call' }));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ activity: 'room_call', text: '' });
    turn.observe(event(EventType.TOOL_CALL_END));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ activity: 'room_call' });
    turn.observe(event(EventType.TOOL_CALL_RESULT));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ activity: null });
    turn.observe(event(EventType.TEXT_MESSAGE_START));
    turn.observe(text('Done.'));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ activity: null, text: 'Done.', reset: true });

    turn.end();
    turn.end();
    turn.observe(text('late'));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ done: true, text: '' });
    expect(sent.filter((message) => message.done)).toHaveLength(1);
    expect(live.snapshot('room')).toEqual([]);
  });

  it('shows a turn from its start, also one that writes nothing, and never lets a secret through in a piece', () => {
    const silent = live.turn({ roomId: 'room', actor: 'lead' });
    silent.end();
    expect(sent.map((message) => [message.actor, message.text, message.done])).toEqual([
      ['lead', '', false],
      ['lead', '', true],
    ]);

    const turn = live.turn({ roomId: 'room', actor: 'worker', taskId: 't1', environmentId: 'here' });
    turn.observe(text('The key is '));
    vi.advanceTimersByTime(RoomLive.EVERY);
    turn.observe(text('sk-ant-api03-'));
    turn.observe(text('A'.repeat(90)));
    vi.advanceTimersByTime(RoomLive.EVERY);
    expect(sent.at(-1)).toMatchObject({ reset: true, taskId: 't1', environmentId: 'here' });
    expect(sent.at(-1)?.text).toContain('The key is ');
    expect(sent.map((message) => message.text).join('')).not.toContain('A'.repeat(90));
    expect(live.snapshot('room')[0]?.text).not.toContain('A'.repeat(90));
  });
});
