import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  EntryApiClient,
  provideMockApi,
  roomsDetail,
  roomsAnswerLead,
  roomsPost,
  roomsWorkers,
  threadsGetProtection,
} from '@pi-kit/api';
import type { Room, RoomDetail, RoomEvent, RoomStreamLine } from '@pi-kit/protocol';
import { Subject } from 'rxjs';
import { OpenRoomStore } from './open-room.store';

const room: Room = {
  id: 'a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c',
  title: 'Watcher fix on Linux',
  repository: 'github.com/acme/pi-kit',
  hostInstanceId: '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01',
  baseCommit: 'a'.repeat(40),
  waiting: 0,
  createdAt: 1,
};
const event = (seq: number, actor: RoomEvent['actor'], text: string): RoomEvent => ({
  roomId: room.id,
  seq,
  kind: 'message',
  actor,
  text,
  images: 0,
  taskId: null,
  createdAt: seq,
});

describe('OpenRoomStore', () => {
  let lines: Subject<RoomStreamLine>;
  const detail = vi.fn(async (): Promise<RoomDetail> => ({
    room,
    summary: 'Run the tests.',
    lead: 'idle',
    leadThreadId: 'lead-1',
    projectFolder: '/srv/pi-kit',
    mode: 'supervised',
    paused: false,
    playbook: null,
    stage: null,
    stages: [],
    actions: [],
    memory: [],
    leadQuestions: [],
    events: [event(1, 'owner', 'Hello')],
    tasks: [],
  }));
  const post = vi.fn(async (body: { text: string }) => event(2, 'owner', body.text));
  const protection = vi.fn(async () => ({ mode: 'sandboxed', state: 'active' }));
  const stream = vi.fn(() => lines.asObservable());
  const answerLead = vi.fn(async (): Promise<RoomDetail> => ({ ...(await detail()), lead: 'working' }));

  beforeEach(() => {
    lines = new Subject<RoomStreamLine>();
    detail.mockClear();
    post.mockClear();
    stream.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi(
          [
            [roomsDetail, detail, () => []],
            [roomsPost, post, (o) => [o.body]],
            [roomsAnswerLead, answerLead, (o) => [o.body]],
            [threadsGetProtection, protection, () => []],
            [
              roomsWorkers,
              async () => [{ environmentId: 'desk', name: 'Desktop', local: false, ready: true, reason: null }],
              () => [],
            ],
          ],
          [[/\/api\/rooms\/[^/]+\/events/, stream, () => []]],
        ),
        {
          provide: EntryApiClient,
          useFactory: () => {
            const api = inject(ApiClient);
            return { client: api.client, forOwner: () => api.client };
          },
        },
      ],
    });
  });

  it('opens a room with its history, lead and protection, and follows new events', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(stream).toHaveBeenCalled());
    expect(store.summary()).toBe('Run the tests.');
    expect(store.leadThreadId()).toBe('lead-1');
    expect(store.projectFolder()).toBe('/srv/pi-kit');
    await vi.waitFor(() => expect(store.protection()?.mode).toBe('sandboxed'));
    await vi.waitFor(() => expect(store.environmentName('desk')).toBe('Desktop'));
    await vi.waitFor(() => expect(lines.observed).toBe(true));
    lines.next({ type: 'lead', state: 'working' });
    lines.next({ type: 'event', event: event(2, 'lead', 'Hi') });
    lines.next({ type: 'event', event: event(2, 'lead', 'Hi') });
    await vi.waitFor(() => expect(store.lead()).toBe('working'));
    await vi.waitFor(() => expect(store.events().map((e) => e.text)).toEqual(['Hello', 'Hi']));
    store.close();
    expect(store.room()).toBeUndefined();
  });

  it('posts, adds its own message once, and marks the lead working', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(stream).toHaveBeenCalled());
    expect(await store.post('  Can Desktop run it?  ', 'lead')).toBe(true);
    expect(post).toHaveBeenCalledWith({ text: 'Can Desktop run it?', route: 'lead' });
    expect(store.events().map((e) => e.seq)).toEqual([1, 2]);
    expect(store.lead()).toBe('working');
    store.close();
  });

  it('follows the room’s mode and pause from the stream', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(lines.observed).toBe(true));
    expect(store.mode()).toBe('supervised');
    lines.next({ type: 'room', mode: 'assisted', paused: true });
    await vi.waitFor(() => expect(store.mode()).toBe('assisted'));
    expect(store.paused()).toBe(true);
    store.close();
  });

  it('shows what the lead asks and clears it once answered', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(lines.observed).toBe(true));
    lines.next({
      type: 'lead',
      state: 'working',
      questions: [{ id: 'd1', method: 'confirm', title: 'Read the logs?' }],
    });
    await vi.waitFor(() => expect(store.leadQuestions().map((q) => q.title)).toEqual(['Read the logs?']));
    await store.answerLead([{ id: 'd1', confirmed: true }]);
    expect(answerLead).toHaveBeenCalledWith({ answers: [{ id: 'd1', confirmed: true }] });
    expect(store.leadQuestions()).toEqual([]);
    lines.next({ type: 'lead', state: 'working', questions: [{ id: 'd2', method: 'input', title: 'Port?' }] });
    lines.next({ type: 'lead', state: 'idle' });
    await vi.waitFor(() => expect(store.lead()).toBe('idle'));
    expect(store.leadQuestions()).toEqual([]);
    store.close();
  });
});
