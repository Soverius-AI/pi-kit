import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCard, SendMessageRequest, StreamResponse, Task, TaskState, formatSSEEvent } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { A2A_ROOM_EXTENSION, type RoomStreamLine, type RoomTaskReport } from '@pi-kit/protocol';
import type { AguiService, HeadlessRun } from '../agui/agui.service';
import type { BackendConfig } from '../app/config';
import { A2aAgentsRepository } from '../db/a2a-agents.repository';
import { A2aTasksRepository } from '../db/a2a-tasks.repository';
import { DatabaseService } from '../db/database.service';
import { InstanceRepository } from '../db/instance.repository';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PeerProxy } from '../peers/peer-proxy';
import type { PeersService } from '../peers/peers.service';
import type { PiSessionService } from '../pi/pi-session.service';
import type { RoomToolsHook } from '../pi/room-tools';
import type { ThreadsService } from '../threads/threads.service';
import { A2A_PUSH_PATH, RoomA2a } from './room-a2a';
import { RoomA2aClient } from './room-a2a.client';
import { RoomA2aAgents } from './room-a2a-agents';
import type { SecretsService } from '../secrets/secrets.service';
import { RoomA2aPushSender } from './room-a2a.push-sender';
import { RoomA2aPushStore } from './room-a2a.push-store';
import { RoomA2aServer } from './room-a2a.server';
import { RoomA2aTaskStore } from './room-a2a.task-store';
import { RoomOutbox } from './room-outbox';
import { RoomAgents } from './room-agents';
import { RoomBus } from './room-bus';
import { RoomDirectoryService } from './room-directory.service';
import { RoomEnvironments } from './room-environments';
import { RoomQuestions } from './room-questions';
import type { RoomLeadService } from './room-lead.service';
import { RoomTasksService } from './room-tasks.service';
import { RoomWorkerRunner } from './room-worker-runner';
import { RoomWorkerService } from './room-worker.service';
import { RoomsService } from './rooms.service';

interface Instance {
  id: string;
  name: string;
  db: DatabaseService;
  rooms: RoomsRepository;
  meta: MetaRepository;
  rows: ThreadsRepository;
  bus: RoomBus;
  tasks: RoomTasksService;
  worker: RoomWorkerService;
  a2a: RoomA2aServer;
  outbox: RoomOutbox;
  restartA2a: () => RoomA2aServer;
  outside: RoomA2aAgents;
  directory: RoomDirectoryService;
  hosted: RoomsService;
  hook?: RoomToolsHook;
}

let base: string;
let project: string;
let host: Instance;
let desktop: Instance;
let roomId: string;
let work: (folder: string) => HeadlessRun;
let offline: Set<string>;
let asking: boolean;
const resumed = vi.fn();
const workerPrompts: string[] = [];
const prompt = vi.fn((_roomId: string, _text: string) => true);
const lead = {
  prompt,
  nudge: vi.fn(async (roomId: string, text: string) => {
    prompt(roomId, text);
  }),
};
const abort = vi.fn(async () => undefined);
const instances = new Map<string, Instance>();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], {
    encoding: 'utf8',
  }).trim();

const network = (self: () => Instance): PeerProxy =>
  ({
    call: async (
      peerId: string,
      path: string,
      _method: string,
      body?: unknown,
      options: { headers?: Record<string, string> } = {},
    ) => {
      if (offline.has(peerId)) throw new Error('connect ECONNREFUSED');
      const target = instances.get(peerId);
      if (!target) throw new Error('unknown peer');
      const caller = self().id;
      const headers = options.headers ?? {};
      try {
        if (path === '/api/a2a/.well-known/agent-card.json') return { status: 200, body: await target.a2a.card() };
        if (path === '/api/rooms') return { status: 200, body: await target.hosted.hosted() };
        if (path === '/api/a2a')
          return {
            status: 200,
            body: await target.a2a.handle(
              caller,
              headers['a2a-version'],
              headers['a2a-extensions'],
              body as Record<string, unknown>,
            ),
          };
        if (path === A2A_PUSH_PATH)
          return {
            status: 204,
            body: await target.tasks.push(caller, headers['x-a2a-notification-token'], body),
          };
      } catch (error) {
        const status = (error as { getStatus?: () => number }).getStatus?.() ?? 500;
        return { status, body: { message: (error as Error).message } };
      }
      throw new Error(`no route ${path}`);
    },
  }) as unknown as PeerProxy;

let outsideMode: 'done' | 'ask' | 'bundle' | 'hang' | 'slow';
let outsideBundle = '';
const outsideAuth: (string | null)[] = [];
let outsideStreams = 0;
const outsideExecutor: AgentExecutor = {
  execute: async (context, bus) => {
    const said = context.userMessage.parts
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('');
    const task = (state: string, text?: string) =>
      Task.fromJSON({
        id: context.taskId,
        contextId: context.contextId,
        status: {
          state,
          ...(text ? { message: { messageId: `q-${context.taskId}`, role: 'ROLE_AGENT', parts: [{ text }] } } : {}),
        },
      });
    const finish = (parts: Record<string, unknown>[]) => {
      bus.publish(
        AgentEvent.artifactUpdate(
          StreamResponse.fromJSON({
            artifactUpdate: {
              taskId: context.taskId,
              contextId: context.contextId,
              artifact: { artifactId: 'out', parts },
            },
          }).payload!.value as never,
        ),
      );
      bus.publish(
        AgentEvent.statusUpdate(
          StreamResponse.fromJSON({
            statusUpdate: {
              taskId: context.taskId,
              contextId: context.contextId,
              status: { state: 'TASK_STATE_COMPLETED' },
            },
          }).payload!.value as never,
        ),
      );
    };
    if (context.task) {
      bus.publish(AgentEvent.task(task('TASK_STATE_WORKING')));
      finish([{ text: `Using port ${said}.` }]);
      return;
    }
    if (outsideMode === 'ask') {
      bus.publish(AgentEvent.task(task('TASK_STATE_INPUT_REQUIRED', 'Which port?')));
      return;
    }
    bus.publish(AgentEvent.task(task('TASK_STATE_WORKING')));
    if (outsideMode === 'hang') return;
    if (outsideMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 150));
    if (outsideMode === 'bundle')
      finish([
        { text: 'Added c.txt.' },
        { raw: outsideBundle, mediaType: 'application/x-git-bundle', filename: 'c.bundle' },
      ]);
    else finish([{ text: 'Did it.' }]);
  },
  cancelTask: async () => undefined,
};
const outsideCard = AgentCard.fromJSON({
  name: 'Outside coder',
  description: 'An A2A agent that is not pi-kit.',
  version: '1',
  supportedInterfaces: [{ url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'code', name: 'Code', description: 'Writes code.', tags: ['code'] }],
});
const outsideRpc = new JsonRpcTransportHandler(
  new DefaultRequestHandler(outsideCard, new InMemoryTaskStore(), outsideExecutor),
);
const outsideFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  outsideAuth.push(new Headers(init.headers).get('authorization'));
  if (url === 'https://agent.example/.well-known/agent-card.json')
    return new Response(JSON.stringify(AgentCard.toJSON(outsideCard)), {
      headers: { 'content-type': 'application/json' },
    });
  if (url === 'https://agent.example/a2a') {
    const answer = await outsideRpc.handle(
      JSON.parse(String(init.body)) as Record<string, unknown>,
      new ServerCallContext({ requestedVersion: '1.0' }),
    );
    if (Symbol.asyncIterator in answer) {
      outsideStreams++;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const event of answer) controller.enqueue(encoder.encode(formatSSEEvent(event)));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const make = async (name: string, folder: string): Promise<Instance> => {
  const dataDir = join(base, name, 'data');
  const db = await DatabaseService.create({ dataDir });
  const rooms = new RoomsRepository(db);
  const rows = new ThreadsRepository(db);
  const meta = new MetaRepository(db);
  let created = 0;
  const threads = {
    create: vi.fn(
      async (
        cwd: string,
        title: string,
        worktree: { base: string },
        _local: unknown,
        options: { onId?: (id: string) => Promise<void> },
      ) => {
        const id = `${name}-worker-${++created}`;
        await options.onId?.(id);
        const path = join(base, name, `wt-${created}`);
        const branch = `pi-kit/task-${created}`;
        git(cwd, 'worktree', 'add', '-q', '-b', branch, path, worktree.base);
        writeFileSync(join(base, name, `${id}.jsonl`), '{}\n');
        await rows.insertDraft({
          id,
          sessionPath: join(base, name, `${id}.jsonl`),
          cwd: path,
          title,
          baseCommit: null,
        });
        return { id, worktree: { path, branch } };
      },
    ),
    setProtection: vi.fn(async () => ({ mode: 'sandboxed', state: 'active', reason: null })),
    protectionOf: vi.fn(async () => ({ mode: 'sandboxed', state: 'active', reason: null })),
    treeSource: vi.fn(async () => ({
      entries: [
        {
          id: 'a',
          parentId: null,
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: `Added b.txt on ${name}.` }] },
        },
      ],
      leafId: 'a',
      path: undefined,
    })),
  } as unknown as ThreadsService;
  const runHeadless = vi.fn(async (_id: string, text: string, options: { cwd: string }) => {
    workerPrompts.push(text);
    return asking ? ({ status: 'interrupted' } as HeadlessRun) : work(options.cwd);
  });
  const resumeHeadless = vi.fn(async (id: string, answers: unknown, options: { cwd: string }) => {
    resumed(id, answers);
    return work(options.cwd);
  });
  const instance = { id: db.instanceId, name, db, rooms, meta, rows } as Instance;
  const sessions = {
    abort,
    pendingDialogs: () =>
      asking ? [{ id: 'd1', request: { method: 'confirm', title: 'Run npm install?', tool: 'bash' } }] : [],
    setRoomTools: (value: RoomToolsHook) => (instance.hook = value),
  } as unknown as PiSessionService;
  const agents = new RoomAgents(rows, threads);
  const questions = new RoomQuestions();
  const runner = new RoomWorkerRunner(
    threads,
    { runHeadless, resumeHeadless } as unknown as AguiService,
    sessions,
    agents,
  );
  const proxy = network(() => instance);
  const client = new RoomA2aClient(proxy);
  const peers = {
    manager: async () => ({
      self: { instanceId: db.instanceId, name },
      peers: [...instances.values()]
        .filter((other) => other.id !== db.instanceId)
        .map((other) => ({ peerId: other.id, name: other.name, state: 'active' })),
    }),
  } as unknown as PeersService;
  instance.bus = new RoomBus(rooms);
  instance.outside = new RoomA2aAgents(new A2aAgentsRepository(db), {
    credentialsEnabled: async () => false,
    store: { available: () => false },
  } as unknown as SecretsService);
  instance.outside.fetchImpl = outsideFetch;
  instance.tasks = new RoomTasksService(
    rooms,
    new InstanceRepository(db),
    sessions,
    instance.bus,
    agents,
    lead as unknown as RoomLeadService,
    runner,
    client,
    peers,
    new RoomEnvironments(new InstanceRepository(db), client, instance.outside, peers),
    questions,
    instance.outside,
    { dataDir } as BackendConfig,
  );
  const a2aTasks = new A2aTasksRepository(db);
  const store = new RoomA2aTaskStore(a2aTasks);
  const pushes = new RoomA2aPushStore(a2aTasks);
  instance.outbox = new RoomOutbox(rooms, proxy);
  const sender = new RoomA2aPushSender(rooms, instance.outbox, pushes);
  instance.worker = new RoomWorkerService(
    rooms,
    meta,
    new InstanceRepository(db),
    runner,
    sessions,
    questions,
    store,
    sender,
    instance.outbox,
  );
  instance.a2a = new RoomA2aServer(instance.worker, store, sender, pushes, peers, new InstanceRepository(db));
  instance.restartA2a = () =>
    new RoomA2aServer(
      instance.worker,
      new RoomA2aTaskStore(new A2aTasksRepository(db)),
      sender,
      new RoomA2aPushStore(new A2aTasksRepository(db)),
      peers,
      new InstanceRepository(db),
    );
  instance.hosted = new RoomsService(rooms, rows, new InstanceRepository(db), meta);
  instance.directory = new RoomDirectoryService(rooms, instance.hosted, proxy, peers);
  instance.tasks.onModuleInit();
  await meta.touchWorkspace(folder);
  instances.set(instance.id, instance);
  return instance;
};

const settle = (taskId: string) =>
  vi.waitFor(async () => expect((await host.rooms.task(taskId))?.state).not.toBe('running'), { timeout: 10_000 });

beforeEach(async () => {
  instances.clear();
  outsideAuth.length = 0;
  outsideStreams = 0;
  outsideMode = 'done';
  offline = new Set();
  asking = false;
  resumed.mockClear();
  workerPrompts.length = 0;
  lead.nudge.mockClear();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-room-tasks-')));
  project = join(base, 'Server', 'pi-kit');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'remote', 'add', 'origin', 'git@github.com:acme/pi-kit.git');
  writeFileSync(join(project, 'a.txt'), 'a\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  const clone = join(base, 'Desktop', 'pi-kit');
  mkdirSync(join(base, 'Desktop'), { recursive: true });
  execFileSync('git', ['clone', '-q', project, clone]);
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/pi-kit.git');
  work = (folder) => {
    writeFileSync(join(folder, 'b.txt'), 'b\nc\n');
    return { status: 'finished' };
  };
  prompt.mockClear();
  abort.mockClear();
  host = await make('Server', project);
  desktop = await make('Desktop', clone);
  writeFileSync(join(base, 'source.jsonl'), '{}\n');
  await host.rows.insertDraft({
    id: 'source',
    sessionPath: join(base, 'source.jsonl'),
    cwd: project,
    baseCommit: null,
  });
  const room = await new RoomsService(host.rooms, host.rows, new InstanceRepository(host.db), host.meta).create({
    threadId: 'source',
    title: 'Watcher fix',
    summary: '',
  });
  roomId = room.id;
  await host.rooms.setLead(roomId, 'lead-thread');
});

afterEach(async () => {
  for (const instance of instances.values()) {
    instance.tasks.onApplicationShutdown();
    instance.outbox.onApplicationShutdown();
  }
  for (const instance of instances.values()) await instance.db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

const propose = async (title = 'Add b', leadThreadId = 'lead-thread', room = roomId) => {
  await host.hook?.propose(leadThreadId, { title, brief: 'Create b.txt.', acceptance: 'b.txt exists.' });
  return (await host.rooms.tasks(room)).at(-1)!;
};

describe('room tasks on this computer', () => {
  it('lets the lead propose a task at the room’s base, on this environment', async () => {
    const lines: RoomStreamLine[] = [];
    host.bus.subscribe(roomId, (line) => lines.push(line));
    const task = await propose();
    expect(task).toMatchObject({ state: 'proposed', base: git(project, 'rev-parse', 'HEAD'), environmentId: host.id });
    expect(lines.map((line) => line.type)).toEqual(['event', 'task']);
    await expect(host.hook?.propose('not-a-lead', { title: 'x', brief: 'y', acceptance: '' })).rejects.toThrow(
      'not the lead',
    );
  });

  it('runs an approved task in its own worktree, commits it, reports the files and tells the lead', async () => {
    const task = await propose();
    expect((await host.tasks.approveTask(roomId, task.id)).state).toBe('running');
    await settle(task.id);
    const done = await host.rooms.task(task.id);
    expect(done).toMatchObject({ state: 'submitted', report: 'Added b.txt on Server.', bundlePath: null });
    expect(done?.files).toEqual([{ path: 'b.txt', added: 2, removed: 0 }]);
    expect(git(join(base, 'Server', 'wt-1'), 'log', '-1', '--format=%an %s')).toBe('pi-kit Room task: Add b');
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith(roomId, expect.stringContaining('b.txt')));
  });

  it('integrates a submitted task into the project’s branch', async () => {
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id);
    await settle(task.id);
    expect((await host.tasks.integrate(roomId, task.id)).state).toBe('integrated');
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('b\nc\n');
    expect(git(project, 'log', '-1', '--format=%s')).toBe('Integrate room task: Add b');
  });

  it('refuses to integrate over uncommitted changes, and leaves the project as it was', async () => {
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id);
    await settle(task.id);
    writeFileSync(join(project, 'a.txt'), 'changed\n');
    await expect(host.tasks.integrate(roomId, task.id)).rejects.toBeInstanceOf(ConflictException);
    expect(existsSync(join(project, 'b.txt'))).toBe(false);
    expect((await host.rooms.task(task.id))?.state).toBe('submitted');
  });

  it('declines a proposal, and refuses actions in the wrong state', async () => {
    const task = await propose();
    expect((await host.tasks.decline(roomId, task.id)).state).toBe('declined');
    await expect(host.tasks.approveTask(roomId, task.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(host.tasks.integrate(roomId, task.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks a task failed when its worker fails, and stopped when it stops at a question nobody can see', async () => {
    work = () => ({ status: 'error', error: 'No model.' });
    const failing = await propose();
    await host.tasks.approveTask(roomId, failing.id);
    await settle(failing.id);
    expect((await host.rooms.task(failing.id))?.state).toBe('failed');
    work = () => ({ status: 'interrupted' });
    const asking = await propose('Ask');
    await host.tasks.approveTask(roomId, asking.id);
    await settle(asking.id);
    expect((await host.rooms.task(asking.id))?.state).toBe('stopped');
    expect(abort).toHaveBeenCalledWith('Server-worker-2');
  });
});

describe('room tasks on another machine', () => {
  it('lists this computer and the paired machines that can take tasks', async () => {
    offline.add(desktop.id);
    expect(await host.tasks.candidates(roomId)).toEqual([
      { environmentId: host.id, name: 'Server', local: true, ready: true, reason: null },
      { environmentId: desktop.id, name: 'Desktop', local: false, ready: false, reason: 'Desktop is offline.' },
    ]);
  });

  it('runs a task on Desktop’s own clone, brings the result back as a bundle and integrates it here', async () => {
    const task = await propose();
    expect((await host.tasks.approveTask(roomId, task.id, desktop.id)).state).toBe('running');
    await settle(task.id);
    const done = await host.rooms.task(task.id);
    expect(done).toMatchObject({ state: 'submitted', environmentId: desktop.id, report: 'Added b.txt on Desktop.' });
    expect(done?.files).toEqual([{ path: 'b.txt', added: 2, removed: 0 }]);
    expect(done?.bundlePath && existsSync(done.bundlePath)).toBe(true);
    expect((await desktop.rooms.workerTask(task.id))?.state).toBe('submitted');
    expect((await desktop.rows.list()).map((row) => row.id)).toEqual([]);
    expect((await host.tasks.integrate(roomId, task.id)).state).toBe('integrated');
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('b\nc\n');
  });

  it('keeps the result on Desktop while the host is offline and delivers it when the host is back', async () => {
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    offline.add(host.id);
    await vi.waitFor(async () => expect((await desktop.rooms.workerTask(task.id))?.state).toBe('submitted'), {
      timeout: 10_000,
    });
    await vi.waitFor(async () => expect((await desktop.rooms.outbox()).at(0)?.tries).toBe(1));
    const completed = async () =>
      (await desktop.rooms.outbox())
        .map((item) => item.body as { task?: { status?: { state?: string } } })
        .find((body) => body.task?.status?.state === 'TASK_STATE_COMPLETED')?.task;
    await vi.waitFor(async () => expect(await completed()).toBeDefined(), { timeout: 10_000 });
    expect(await completed()).toMatchObject({
      contextId: roomId,
      artifacts: [{ artifactId: 'report' }, { artifactId: 'changes' }],
    });
    expect((await host.rooms.task(task.id))?.state).toBe('running');
    offline.clear();
    await desktop.outbox.flush(Date.now() + 60_000);
    expect(await desktop.rooms.outbox()).toEqual([]);
    expect((await host.rooms.task(task.id))?.state).toBe('submitted');
  });

  it('reports a task that was running when Desktop’s pi-kit restarted as failed', async () => {
    work = () => new Promise<HeadlessRun>(() => undefined) as unknown as HeadlessRun;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await vi.waitFor(async () => expect((await desktop.rooms.workerTask(task.id))?.workerThreadId).toBeTruthy());
    await desktop.worker.recover();
    const failed = await host.rooms.task(task.id);
    expect(failed?.state).toBe('failed');
    expect((await host.rooms.events(roomId)).at(-1)?.text).toContain('restarted');
    expect((await desktop.rooms.workerTask(task.id))?.state).toBe('failed');
  });

  it('starts nothing when the machine is offline or has no clone with the base commit', async () => {
    const task = await propose();
    offline.add(desktop.id);
    await expect(host.tasks.approveTask(roomId, task.id, desktop.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect((await host.rooms.task(task.id))?.state).toBe('proposed');
    offline.clear();
    git(project, 'commit', '-q', '--allow-empty', '-m', 'only on the server');
    const newer = await new RoomsService(host.rooms, host.rows, new InstanceRepository(host.db), host.meta).create({
      threadId: 'source',
      title: 'Newer',
      summary: '',
    });
    await host.rooms.setLead(newer.id, 'lead-2');
    const later = await propose('Later', 'lead-2', newer.id);
    await expect(host.tasks.approveTask(newer.id, later.id, desktop.id)).rejects.toThrow('No project on this computer');
    expect((await host.rooms.task(later.id))?.state).toBe('proposed');
  });

  it('accepts reports only from the machine running the task, and offers only from the room’s host', async () => {
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await settle(task.id);
    const report: RoomTaskReport = {
      attempt: 1,
      environmentId: host.id,
      state: 'failed',
      branch: null,
      head: null,
      report: null,
      files: [],
      bundle: null,
      note: null,
      questions: [],
    };
    await expect(host.tasks.report(host.id, roomId, task.id, report)).rejects.toBeInstanceOf(ForbiddenException);
    const offer = RoomA2a.offer(
      {
        roomId,
        roomTitle: 'x',
        taskId: task.id,
        attempt: 2,
        title: 't',
        brief: 'b',
        acceptance: '',
        repository: 'github.com/acme/pi-kit',
        base: task.base,
      },
      { url: RoomA2a.peerUrl('someone-else', A2A_PUSH_PATH), token: 't' },
    );
    const refused = await desktop.a2a.handle('someone-else', '1.0', A2A_ROOM_EXTENSION, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: SendMessageRequest.toJSON(offer),
    });
    expect(refused['result']).toMatchObject({ task: { status: { state: 'TASK_STATE_REJECTED' } } });
  });

  it('takes pushes only with the task’s notification token', async () => {
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await settle(task.id);
    const a2aTaskId = (await host.rooms.task(task.id))?.a2aTaskId ?? '';
    const failed = RoomA2a.task(a2aTaskId, roomId, TaskState.TASK_STATE_FAILED, {
      taskId: task.id,
      attempt: 1,
      environmentId: desktop.id,
    });
    const push = StreamResponse.toJSON({ payload: { $case: 'task', value: failed } });
    await expect(host.tasks.push(desktop.id, 'wrong', push)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(host.tasks.push(desktop.id, undefined, push)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await host.rooms.task(task.id))?.state).toBe('submitted');
  });
});

describe('the A2A agent', () => {
  const rpc = (method: string, params: unknown, options: { version?: string; extensions?: string } = {}) =>
    desktop.a2a.handle(host.id, options.version ?? '1.0', options.extensions ?? A2A_ROOM_EXTENSION, {
      jsonrpc: '2.0',
      id: 7,
      method,
      params,
    });
  const code = (answer: Record<string, unknown>) => (answer['error'] as { code?: number } | undefined)?.code;

  it('publishes an A2A 1.0 agent card that names the room-task extension', async () => {
    const card = AgentCard.fromJSON(await desktop.a2a.card());
    expect(card.supportedInterfaces.map((face) => [face.url, face.protocolBinding, face.protocolVersion])).toEqual([
      [`pi-kit-peer://${desktop.id}/api/a2a`, 'JSONRPC', '1.0'],
    ]);
    expect(card.capabilities?.pushNotifications).toBe(true);
    expect(RoomA2a.takesRoomTasks(card)).toBe(true);
    expect(card.skills.map((skill) => skill.id)).toEqual(['room-task']);
  });

  it('publishes the same agent at the well-known address with its HTTP interface and bearer security', async () => {
    const card = AgentCard.fromJSON(await desktop.a2a.card('http://127.0.0.1:4300'));
    expect(card.supportedInterfaces.map((face) => face.url)).toEqual([
      'http://127.0.0.1:4300/api/a2a',
      `pi-kit-peer://${desktop.id}/api/a2a`,
    ]);
    expect(card.securitySchemes['bearer']?.scheme).toMatchObject({ $case: 'httpAuthSecurityScheme' });
    expect(card.securityRequirements.map((requirement) => Object.keys(requirement.schemes))).toEqual([['bearer']]);
    expect(RoomA2a.takesRoomTasks(card)).toBe(true);
    const peer = AgentCard.fromJSON(await desktop.a2a.card());
    expect(peer.securityRequirements).toEqual([]);
  });

  it('answers in JSON-RPC with the A2A errors', async () => {
    expect(code(await rpc('Foo', {}))).toBe(-32601);
    expect(code(await rpc('GetTask', { id: 'x' }, { version: '0.3' }))).toBe(-32009);
    expect(code(await rpc('GetTask', { id: '5f0c6a43-8f1e-4a7b-9d4e-2c1b0a9f8e7d' }))).toBe(-32001);
    const plain = { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Write a poem.' }] } };
    expect(code(await rpc('SendMessage', plain, { extensions: '' }))).toBeLessThan(0);
    expect((await rpc('SendMessage', plain))['result']).toMatchObject({
      task: { status: { state: 'TASK_STATE_REJECTED' } },
    });
  });

  it('runs a room task sent as an A2A message, and shows it only to its host', async () => {
    work = () => new Promise<HeadlessRun>(() => undefined) as unknown as HeadlessRun;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    const id = (await host.rooms.task(task.id))?.a2aTaskId ?? '';
    expect((await rpc('GetTask', { id }))['result']).toMatchObject({
      id,
      contextId: roomId,
      status: { state: 'TASK_STATE_WORKING' },
      metadata: { [A2A_ROOM_EXTENSION]: { taskId: task.id, attempt: 1, environmentId: desktop.id } },
    });
    expect((await rpc('ListTasks', { contextId: roomId }))['result']).toMatchObject({ tasks: [{ id }], totalSize: 1 });
    const other = await desktop.a2a.handle(desktop.id, '1.0', A2A_ROOM_EXTENSION, {
      jsonrpc: '2.0',
      id: 2,
      method: 'GetTask',
      params: { id },
    });
    expect(code(other)).toBe(-32001);
  });
});

describe('outside A2A agents', () => {
  const addAgent = async () => await host.outside.add({ url: 'https://agent.example', token: 'secret' });
  const settledOutside = (id: string) =>
    vi.waitFor(async () => expect((await host.rooms.task(id))?.state).not.toBe('running'), { timeout: 5000 });

  it('lists an outside agent as a worker, not as a room host, and keeps its token out of the answer', async () => {
    const agent = await addAgent();
    expect(agent).toMatchObject({ name: 'Outside coder', tokenStorage: 'database' });
    expect(Object.keys(agent)).not.toContain('token');
    expect((await host.tasks.candidates(roomId)).find((c) => c.environmentId === agent.id)).toMatchObject({
      name: 'Outside coder',
      ready: true,
    });
    expect(outsideAuth.at(-1)).toBe('Bearer secret');
  });

  it('runs a task on an outside agent and keeps its text report', async () => {
    outsideMode = 'done';
    const agent = await addAgent();
    const task = await propose();
    expect((await host.tasks.approveTask(roomId, task.id, agent.id)).state).toBe('running');
    await settledOutside(task.id);
    const done = await host.rooms.task(task.id);
    expect(done).toMatchObject({ state: 'submitted', environmentId: agent.id, report: 'Did it.', head: null });
    expect((await host.rooms.events(roomId)).at(-1)?.text).toContain('returned no commits');
    await expect(host.tasks.integrate(roomId, task.id)).rejects.toThrow('no commits');
  });

  it('follows a streaming outside agent and takes its result without polling', async () => {
    outsideMode = 'slow';
    const agent = await addAgent();
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, agent.id);
    expect((await host.rooms.task(task.id))?.state).toBe('running');
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.state).toBe('submitted'), {
      timeout: 5000,
    });
    expect(outsideStreams).toBeGreaterThan(0);
    expect((await host.rooms.task(task.id))?.report).toBe('Did it.');
  });

  it('relays an outside agent’s question and sends the answer as text', async () => {
    outsideMode = 'ask';
    const agent = await addAgent();
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, agent.id);
    const asking = await host.rooms.task(task.id);
    expect(asking?.questions).toEqual([{ id: expect.any(String), method: 'input', title: 'Which port?' }]);
    await host.tasks.answer(roomId, task.id, { answers: [{ id: asking?.questions[0]?.id ?? '', value: '5173' }] });
    await settledOutside(task.id);
    expect(await host.rooms.task(task.id)).toMatchObject({ state: 'submitted', report: 'Using port 5173.' });
  });

  it('integrates the commits an outside agent returns as a git bundle', async () => {
    const work = join(base, 'outside');
    execFileSync('git', ['clone', '-q', project, work]);
    git(work, 'checkout', '-q', '-b', 'outside/c');
    writeFileSync(join(work, 'c.txt'), 'c\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'Add c');
    git(work, 'bundle', 'create', '-q', join(base, 'c.bundle'), 'outside/c', `^${git(project, 'rev-parse', 'HEAD')}`);
    outsideBundle = readFileSync(join(base, 'c.bundle')).toString('base64');
    outsideMode = 'bundle';
    const agent = await addAgent();
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, agent.id);
    await settledOutside(task.id);
    const done = await host.rooms.task(task.id);
    expect(done).toMatchObject({
      state: 'submitted',
      branch: 'refs/heads/outside/c',
      head: git(work, 'rev-parse', 'HEAD'),
    });
    expect(done?.files).toEqual([{ path: 'c.txt', added: 1, removed: 0 }]);
    expect((await host.tasks.integrate(roomId, task.id)).state).toBe('integrated');
    expect(readFileSync(join(project, 'c.txt'), 'utf8')).toBe('c\n');
  });

  it('stops a task on an outside agent', async () => {
    outsideMode = 'hang';
    const agent = await addAgent();
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, agent.id);
    await host.tasks.poll();
    expect((await host.rooms.task(task.id))?.state).toBe('running');
    await host.tasks.stop(roomId, task.id);
    expect((await host.rooms.task(task.id))?.state).toBe('stopped');
  });
});

describe('A2A push settings', () => {
  const call = (server: RoomA2aServer, method: string, params: unknown) =>
    server.handle(host.id, '1.0', A2A_ROOM_EXTENSION, { jsonrpc: '2.0', id: 3, method, params });

  it('keeps push settings across a restart, refuses other targets, and pushes to each', async () => {
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.questions).toHaveLength(1), {
      timeout: 10_000,
    });
    const id = (await host.rooms.task(task.id))?.a2aTaskId ?? '';
    const url = RoomA2a.peerUrl(host.id, A2A_PUSH_PATH);
    const created = await call(desktop.a2a, 'CreateTaskPushNotificationConfig', { taskId: id, url, token: 'second' });
    expect(created['result']).toMatchObject({ taskId: id, url, token: 'second' });
    const extra = (created['result'] as { id: string }).id;
    const foreign = await call(desktop.a2a, 'CreateTaskPushNotificationConfig', {
      taskId: id,
      url: 'https://example.com/hook',
    });
    expect((foreign['error'] as { code: number }).code).toBe(-32602);
    const restarted = desktop.restartA2a();
    const listed = await call(restarted, 'ListTaskPushNotificationConfigs', { taskId: id });
    expect((listed['result'] as { configs: { token: string }[] }).configs.map((config) => config.token)).toHaveLength(
      2,
    );
    expect((await call(restarted, 'GetTaskPushNotificationConfig', { taskId: id, id: extra }))['result']).toMatchObject(
      {
        token: 'second',
      },
    );
    offline.add(host.id);
    await host.tasks.stop(roomId, task.id);
    await vi.waitFor(
      async () => {
        const finals = (await desktop.rooms.outbox()).filter(
          (item) =>
            (item.body as { task?: { status?: { state?: string } } }).task?.status?.state === 'TASK_STATE_CANCELED',
        );
        expect(finals.map((item) => item.token === 'second')).toEqual([false, true]);
      },
      { timeout: 10_000 },
    );
    offline.clear();
    await desktop.outbox.flush(Date.now() + 600_000);
    expect(await desktop.rooms.outbox()).toEqual([]);
    expect((await host.rooms.task(task.id))?.state).toBe('stopped');
    await call(restarted, 'DeleteTaskPushNotificationConfig', { taskId: id, id: extra });
    const left = await call(restarted, 'ListTaskPushNotificationConfigs', { taskId: id });
    expect((left['result'] as { configs: unknown[] }).configs).toHaveLength(1);
  });
});

describe('A2A streaming', () => {
  const states = (events: Record<string, unknown>[]) =>
    events.map((event) => {
      const result = event['result'] as {
        task?: { status?: { state?: string } };
        statusUpdate?: { status?: { state?: string } };
        artifactUpdate?: { artifact?: { artifactId?: string } };
      };
      if (result.artifactUpdate) return `artifact ${result.artifactUpdate.artifact?.artifactId}`;
      return result.task ? `task ${result.task.status?.state}` : `status ${result.statusUpdate?.status?.state}`;
    });
  const collect = async (
    answer: Record<string, unknown> | AsyncGenerator<Record<string, unknown>, void, undefined>,
  ) => {
    if (!(Symbol.asyncIterator in answer)) throw new Error(`Expected a stream, got ${JSON.stringify(answer)}`);
    const events: Record<string, unknown>[] = [];
    for await (const event of answer) events.push(event);
    return events;
  };

  it('streams a room task from start to its result with SendStreamingMessage', async () => {
    const task = await propose();
    const request = SendMessageRequest.toJSON(
      RoomA2a.offer(
        {
          roomId,
          roomTitle: 'Watcher fix',
          taskId: task.id,
          attempt: 1,
          title: task.title,
          brief: task.brief,
          acceptance: task.acceptance,
          repository: 'github.com/acme/pi-kit',
          base: task.base,
        },
        { url: RoomA2a.peerUrl(host.id, A2A_PUSH_PATH), token: 't' },
      ),
    ) as { configuration?: Record<string, unknown> };
    delete request.configuration;
    const events = await collect(
      await desktop.a2a.serve(host.id, '1.0', A2A_ROOM_EXTENSION, {
        jsonrpc: '2.0',
        id: 'stream-1',
        method: 'SendStreamingMessage',
        params: request,
      }),
    );
    expect(events.every((event) => event['id'] === 'stream-1')).toBe(true);
    expect(states(events)).toEqual([
      'task TASK_STATE_WORKING',
      'status TASK_STATE_WORKING',
      'artifact report',
      'artifact changes',
      'status TASK_STATE_COMPLETED',
    ]);
    const bundle = (
      events[3]['result'] as { artifactUpdate: { artifact: { parts: { mediaType?: string; raw?: string }[] } } }
    ).artifactUpdate.artifact.parts[0];
    expect(bundle.mediaType).toBe('application/x-git-bundle');
    expect(bundle.raw?.length).toBeGreaterThan(0);
  });

  it('resubscribes to a task that waits for an answer and ends the stream when it is stopped', async () => {
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.questions).toHaveLength(1), {
      timeout: 10_000,
    });
    const id = (await host.rooms.task(task.id))?.a2aTaskId ?? '';
    const stream = await desktop.a2a.serve(host.id, '1.0', A2A_ROOM_EXTENSION, {
      jsonrpc: '2.0',
      id: 9,
      method: 'SubscribeToTask',
      params: { id },
    });
    const collected = collect(stream);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.tasks.stop(roomId, task.id);
    const events = await collected;
    expect(states(events)[0]).toBe('task TASK_STATE_INPUT_REQUIRED');
    expect(states(events).at(-1)).toBe('status TASK_STATE_CANCELED');
    await settle(task.id);
    expect((await host.rooms.task(task.id))?.state).toBe('stopped');
  });
});

describe('rooms across environments', () => {
  it('lists this environment’s rooms with every paired environment’s, and keeps them while a host is offline', async () => {
    const head = git(project, 'rev-parse', 'HEAD');
    const remote = await desktop.hosted.create({
      title: 'Started on the desktop',
      summary: '',
      repository: 'github.com/acme/pi-kit',
      baseCommit: head,
    });
    expect((await desktop.rooms.get(remote.id))?.projectFolder).toBe(join(base, 'Desktop', 'pi-kit'));
    await propose();
    const listed = await host.directory.list();
    expect(listed.map((entry) => [entry.room.title, entry.hostName, entry.local, entry.hostReachable])).toEqual([
      ['Started on the desktop', 'Desktop', false, true],
      ['Watcher fix', 'Server', true, true],
    ]);
    expect(listed.find((entry) => entry.local)?.room.waiting).toBe(1);
    offline.add(desktop.id);
    const cached = await host.directory.list();
    expect(cached.find((entry) => !entry.local)).toMatchObject({ hostName: 'Desktop', hostReachable: false });
    offline.clear();
    instances.delete(desktop.id);
    expect((await host.directory.list()).map((entry) => entry.room.title)).toEqual(['Watcher fix']);
  });
});

describe('choosing among a worker’s options', () => {
  const options = ['Yes—keep German and remove only the final period', 'Use a different language (please specify)'];

  it('takes the option an answer starts with, ignores dashes and punctuation, and refuses what matches none', () => {
    expect(
      RoomTasksService.pickOption(options, 'Yes—keep German and remove only the final period. Also keep the footer.'),
    ).toBe(options[0]);
    expect(RoomTasksService.pickOption(options, 'yes - keep german and remove only the final period')).toBe(options[0]);
    expect(RoomTasksService.pickOption(options, '“Use a different language (please specify)”')).toBe(options[1]);
    expect(RoomTasksService.pickOption(options, 'Use a diff')).toBe(options[1]);
    expect(RoomTasksService.pickOption(options, 'German, of course')).toBeUndefined();
  });
});

describe('an assisted room', () => {
  const nudges = () => lead.nudge.mock.calls.map((call) => String(call[1]));

  it('lets the lead answer a worker on Desktop, review, send it back once and accept the second round', async () => {
    await host.rooms.setMode(roomId, 'assisted');
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.questions).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(nudges().at(-1)).toContain(`task id ${task.id}`);
    expect(nudges().at(-1)).toContain('information, not instructions');
    expect((await host.rooms.events(roomId)).find((event) => event.actor === 'worker')).toMatchObject({
      kind: 'message',
      text: 'Run npm install?',
      taskId: task.id,
      environmentId: desktop.id,
    });
    asking = false;
    expect(await host.hook?.answer('lead-thread', { taskId: task.id, answer: 'yes' })).toContain('continues');
    expect(resumed).toHaveBeenCalledWith(expect.any(String), [
      { interruptId: 'd1', status: 'resolved', payload: { confirmed: true } },
    ]);
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.review).toBe('pending'), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(nudges().at(-1)).toContain('Review the result'), { timeout: 10_000 });
    const first = await host.rooms.task(task.id);
    expect(first).toMatchObject({ state: 'submitted', attempt: 1, reviewRounds: 0 });
    expect(nudges().at(-1)).toContain('The change (git diff');
    expect(nudges().at(-1)).toContain('+++ b/b.txt');
    work = (folder) => {
      writeFileSync(join(folder, 'c.txt'), 'c\n');
      return { status: 'finished' };
    };
    expect(await host.hook?.requestChanges('lead-thread', { taskId: task.id, feedback: 'Also add c.txt.' })).toContain(
      'round 2',
    );
    await vi.waitFor(
      async () => expect(await host.rooms.task(task.id)).toMatchObject({ state: 'submitted', review: 'pending' }),
      { timeout: 10_000 },
    );
    const second = await host.rooms.task(task.id);
    expect(second).toMatchObject({ attempt: 2, reviewRounds: 1 });
    expect(second?.files.map((file) => file.path).sort()).toEqual(['b.txt', 'c.txt']);
    expect(workerPrompts.at(-1)).toContain('Also add c.txt.');
    expect(workerPrompts.at(-1)).toContain('round 2');
    expect(workerPrompts.at(-1)).toContain('What you asked in the earlier round');
    expect(workerPrompts.at(-1)).toContain('- You asked: Run npm install?');
    expect(workerPrompts.at(-1)).toContain('The room answered: yes');
    expect(await host.hook?.accept('lead-thread', { taskId: task.id, note: 'b.txt and c.txt are there.' })).toContain(
      'Accepted',
    );
    expect(await host.rooms.task(task.id)).toMatchObject({ review: 'accepted', state: 'submitted' });
    expect((await host.rooms.events(roomId)).at(-1)).toMatchObject({ actor: 'lead' });
    expect((await host.tasks.integrate(roomId, task.id)).state).toBe('integrated');
    expect(readFileSync(join(project, 'c.txt'), 'utf8')).toBe('c\n');
  });

  it('stops sending a task back after three rounds and leaves it to the owner', async () => {
    await host.rooms.setMode(roomId, 'assisted');
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id);
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.review).toBe('pending'), {
      timeout: 10_000,
    });
    await host.rooms.updateTask(task.id, { reviewRounds: 3 });
    expect(await host.hook?.requestChanges('lead-thread', { taskId: task.id, feedback: 'Again.' })).toContain(
      'owner decides',
    );
    expect(await host.rooms.task(task.id)).toMatchObject({ state: 'submitted', review: 'none' });
    expect(await host.hook?.answer('lead-thread', { taskId: task.id, answer: 'yes' })).toContain('asks nothing');
  });

  it('sends questions to the owner while the room is paused or supervised', async () => {
    await host.rooms.setMode(roomId, 'assisted');
    await host.rooms.setPaused(roomId, true);
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id);
    await vi.waitFor(async () => expect((await host.rooms.task(task.id))?.questions).toHaveLength(1), {
      timeout: 10_000,
    });
    expect((await host.rooms.events(roomId)).at(-1)?.text).toContain('needs you');
    expect(nudges().some((text) => text.includes('stopped to ask'))).toBe(false);
  });
});

describe('workers that ask', () => {
  const waitForQuestion = (taskId: string) =>
    vi.waitFor(async () => expect((await host.rooms.task(taskId))?.questions).toHaveLength(1), { timeout: 10_000 });

  it('shows a local worker’s question as waiting, and continues with the owner’s answer', async () => {
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id);
    await waitForQuestion(task.id);
    expect((await host.rooms.task(task.id))?.questions[0]).toMatchObject({ id: 'd1', method: 'confirm', tool: 'bash' });
    expect((await host.rooms.active())[0]?.waiting).toBe(1);
    const events = await host.rooms.events(roomId);
    expect(events.at(-2)).toMatchObject({ actor: 'worker', text: 'Run npm install?', environmentId: host.id });
    expect(events.at(-1)?.text).toContain('needs you');
    await expect(
      host.tasks.answer(roomId, task.id, { answers: [{ id: 'other', confirmed: true }] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await host.tasks.answer(roomId, task.id, { answers: [{ id: 'd1', confirmed: true }] })).questions).toEqual(
      [],
    );
    await settle(task.id);
    expect(resumed).toHaveBeenCalledWith(expect.any(String), [
      { interruptId: 'd1', status: 'resolved', payload: { confirmed: true } },
    ]);
    expect((await host.rooms.task(task.id))?.state).toBe('submitted');
  });

  it('relays a question from Desktop and carries the answer back', async () => {
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await waitForQuestion(task.id);
    await host.tasks.answer(roomId, task.id, { answers: [{ id: 'd1', value: 'yes' }] });
    await settle(task.id);
    expect(resumed).toHaveBeenCalledWith(expect.any(String), [
      { interruptId: 'd1', status: 'resolved', payload: { value: 'yes' } },
    ]);
    expect((await host.rooms.task(task.id))?.state).toBe('submitted');
  });

  it('stops a worker that waits for an answer', async () => {
    asking = true;
    const task = await propose();
    await host.tasks.approveTask(roomId, task.id, desktop.id);
    await waitForQuestion(task.id);
    await host.tasks.stop(roomId, task.id);
    await settle(task.id);
    expect(await host.rooms.task(task.id)).toMatchObject({ state: 'stopped', questions: [] });
    expect(resumed).not.toHaveBeenCalled();
  });
});
