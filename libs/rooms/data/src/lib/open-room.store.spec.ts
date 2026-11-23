import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  EntryApiClient,
  provideMockApi,
  roomsArchive,
  roomsDetail,
  roomsListRuns,
  roomsUpdate,
  roomsAnswerLead,
  roomsPost,
  roomsWorkers,
  threadsGetProtection,
} from '@pi-kit/api';
import type { Room, RoomDetail, RoomEvent, RoomRun, RoomStreamLine } from '@pi-kit/protocol';
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
    folder: '/data/rooms/a6f1d2c3',
    mode: 'supervised',
    paused: false,
    rehearsal: false,
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
  const update = vi.fn(async (body: { title?: string }): Promise<RoomDetail> => ({
    ...(await detail()),
    room: { ...room, title: body.title ?? room.title },
  }));
  const archive = vi.fn(async () => undefined);
  const listRuns = vi.fn(async (): Promise<RoomRun[]> => []);
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
            [roomsUpdate, update, (o) => [o.body]],
            [roomsArchive, archive, (o) => [o.body]],
            [roomsListRuns, listRuns, () => []],
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

  it('knows the room’s folder, renames the room here or from the stream, and closes it once archived', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(lines.observed).toBe(true));
    expect(store.folder()).toBe('/data/rooms/a6f1d2c3');
    await store.update({ title: 'Watcher fix everywhere' });
    expect(update).toHaveBeenCalledWith({ title: 'Watcher fix everywhere' });
    expect(store.room()?.title).toBe('Watcher fix everywhere');
    expect(store.listChanges()).toBe(1);
    lines.next({ type: 'room', title: 'From the phone', mode: 'supervised', paused: false });
    await vi.waitFor(() => expect(store.room()?.title).toBe('From the phone'));
    expect(await store.archive(true)).toBe(true);
    expect(archive).toHaveBeenCalledWith({ stopTasks: true });
    expect(store.room()).toBeUndefined();
    expect(store.listChanges()).toBe(3);
  });

  it('grows what a participant is writing piece by piece, replaces it on a reset and drops it when the turn ends', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(lines.observed).toBe(true));
    const piece = (text: string, more: { reset?: boolean; done?: boolean; activity?: string | null } = {}) =>
      lines.next({
        type: 'live',
        live: {
          id: 'l1',
          actor: 'consultant',
          role: 'security',
          taskId: null,
          environmentId: null,
          text,
          reset: false,
          activity: null,
          done: false,
          ...more,
        },
      });
    piece('No secrets', { reset: true });
    piece(' found.');
    await vi.waitFor(() => expect(store.live().map((speaker) => speaker.text)).toEqual(['No secrets found.']));
    piece('', { activity: 'grep' });
    await vi.waitFor(() => expect(store.live()[0]).toMatchObject({ text: 'No secrets found.', activity: 'grep' }));
    piece('Checked again.', { reset: true });
    await vi.waitFor(() => expect(store.live()[0]?.text).toBe('Checked again.'));
    piece('', { done: true });
    await vi.waitFor(() => expect(store.live()).toEqual([]));
  });

  it('takes the runs from the server again after the stream was lost, and drops what was being written', async () => {
    const run = (state: RoomRun['state']): RoomRun => ({
      id: 'run-1',
      roomId: room.id,
      number: 1,
      cause: 'owner',
      trigger: null,
      title: 'Plan it.',
      playbook: null,
      stage: null,
      state,
      summary: null,
      startedAt: 1,
      endedAt: state === 'running' ? null : 2,
      steps: [],
    });
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(lines.observed).toBe(true));
    lines.next({ type: 'run', run: run('running') });
    lines.next({
      type: 'live',
      live: {
        id: 'l1',
        actor: 'lead',
        role: null,
        taskId: null,
        environmentId: null,
        text: 'Half',
        reset: true,
        activity: null,
        done: false,
      },
    });
    await vi.waitFor(() => expect(store.runs()[0]?.state).toBe('running'));
    listRuns.mockResolvedValueOnce([run('stopped')]);
    const lost = lines;
    lines = new Subject<RoomStreamLine>();
    lost.error(new Error('gone'));
    await vi.waitFor(() => expect(store.live()).toEqual([]));
    await vi.waitFor(() => expect(store.runs()[0]?.state).toBe('stopped'), { timeout: 4000 });
  });

  it('posts and adds its message once; only a lead state event marks work running', async () => {
    const store = TestBed.inject(OpenRoomStore);
    store.open(room);
    await vi.waitFor(() => expect(stream).toHaveBeenCalled());
    expect(await store.post('  Can Desktop run it?  ', 'lead')).toBe(true);
    expect(post).toHaveBeenCalledWith({ text: 'Can Desktop run it?', route: 'lead' });
    expect(store.events().map((e) => e.seq)).toEqual([1, 2]);
    expect(store.lead()).toBe('idle');
    lines.next({ type: 'lead', state: 'working' });
    await vi.waitFor(() => expect(store.lead()).toBe('working'));
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
