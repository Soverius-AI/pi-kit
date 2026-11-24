import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import type { ThreadsRepository } from '../db/threads.repository';
import type { ThreadsService } from '../threads/threads.service';
import type { AguiService } from '../agui/agui.service';
import type { PiSessionService } from '../pi/pi-session.service';
import type { RoomAgents } from './room-agents';
import type { RoomLive } from './room-live';
import type { RoomWorkspace } from './room-workspace.service';
import { RoomConsultant, type ConsultRequest } from './room-consultant.service';

let consultant: RoomConsultant;
let sessions: Map<string, string>;
let sequence: number;
const runHeadless = vi.fn(async (_id: string, _prompt: string, _options: unknown) => ({ status: 'finished' }));
const configure = vi.fn(async (_id: string, _settings: unknown) => undefined);
const execution = vi.fn(async () => ({ cwd: '/room/reference', workspace: false, sandbox: false }));
const prepare = vi.fn(async () => '/room/reference');
let create: ReturnType<typeof vi.fn>;
const request = (): ConsultRequest => ({
  roomId: 'room',
  roomTitle: 'Personal',
  repository: '',
  folder: '/room/reference',
  role: 'planner',
  instructions: 'Help with my week.',
  question: 'Fridays are free; what should I do?',
  settings: { model: 'provider/model', thinking: 'low' },
});
function service() {
  return new RoomConsultant(
    {
      consultThread: async (room: string, role: string) => sessions.get(`${room}:${role}`),
      addConsultThread: async (thread: string, room: string, role: string) => {
        sessions.set(`${room}:${role}`, thread);
      },
    } as unknown as RoomPlaybooksRepository,
    { get: async () => ({}) } as unknown as ThreadsRepository,
    { create } as unknown as ThreadsService,
    { runHeadless } as unknown as AguiService,
    {} as PiSessionService,
    { configure, lastReply: async () => 'Plan ready.' } as unknown as RoomAgents,
    { turn: () => ({ observe: () => undefined, end: () => undefined }) } as unknown as RoomLive,
    { execution, prepare } as unknown as RoomWorkspace,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  sessions = new Map();
  sequence = 0;
  create = vi.fn(async (_cwd, _title, _a, _b, options: { onId: (id: string) => Promise<void> }) => {
    const id = `thread-${++sequence}`;
    await options.onId(id);
    return { id };
  });
  consultant = service();
});
describe('room collaborator conversation identity', () => {
  it('reuses unchanged role settings but starts fresh when instructions or model change, including after restart', async () => {
    await consultant.ask(request());
    const prompt = String(runHeadless.mock.calls[0]?.[1]);
    expect(prompt).toContain('personal assistant collaborator');
    expect(prompt).toContain('do not see the room conversation');
    await consultant.ask({ ...request(), question: 'And next week?' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(runHeadless.mock.calls[1]?.[1]).toBe('And next week?');
    consultant = service();
    await consultant.ask({ ...request(), instructions: 'Focus on family time.' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(String(runHeadless.mock.calls[2]?.[1])).toContain('Focus on family time.');
    await consultant.ask({ ...request(), settings: { model: 'other/model', thinking: 'high' } });
    expect(create).toHaveBeenCalledTimes(3);
    expect(configure).toHaveBeenLastCalledWith('thread-3', { model: 'other/model', thinking: 'high' });
  });
  it('keeps another room separate and uses explicit detached remote reference folders without requiring a local room row', async () => {
    await consultant.ask(request());
    execution.mockClear();
    prepare.mockClear();
    await consultant.ask({ ...request(), roomId: 'host:remote-room', folder: '/remote/reference', detached: true });
    expect(execution).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith(
      '/remote/reference',
      expect.any(String),
      undefined,
      undefined,
      expect.objectContaining({ internal: true }),
    );
    expect(runHeadless).toHaveBeenLastCalledWith(
      'thread-2',
      expect.any(String),
      expect.objectContaining({ cwd: '/remote/reference' }),
    );
  });
});
