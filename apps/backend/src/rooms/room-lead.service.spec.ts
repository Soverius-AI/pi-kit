import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOMS_SETTING_KEY, type RoomStreamLine } from '@pi-kit/protocol';
import { RoomAssistant } from './room-assistant.service';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomMemory } from './room-memory';
import type { RoomWorkspace } from './room-workspace.service';
import { RoomPhoneService } from './room-phone.service';
import { RoomPhoneRepository } from '../db/room-phone.repository';
import type { RoomMessagingTransport } from './room-messaging.transport';
import type { TranscribeService } from '../transcribe/transcribe.service';
import type { RoomPlaybookService } from './room-playbook.service';
import type { AguiService, HeadlessRun } from '../agui/agui.service';
import { DatabaseService } from '../db/database.service';
import { InstanceRepository } from '../db/instance.repository';
import { MetaRepository } from '../db/meta.repository';
import type { ComposioConnectService } from '../mcp/composio/composio-connect.service';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import type { ThreadsService } from '../threads/threads.service';
import { RoomAgents } from './room-agents';
import { RoomBus } from './room-bus';
import { LEAD_BUSY, RoomLeadService } from './room-lead.service';
import { RoomQuestions } from './room-questions';
import { RoomsService } from './rooms.service';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomFolders } from './room-folders';
import { RoomLive } from './room-live';
import { RoomRuns } from './room-runs';
import { RoomRunsRepository } from '../db/room-runs.repository';
import type { BackendConfig } from '../app/config';

let base: string;
let project: string;
let db: DatabaseService;
let rows: ThreadsRepository;
let rooms: RoomsRepository;
let lead: RoomLeadService;
let bus: RoomBus;
let roomId: string;
let runs: RoomRuns;
let reply: string;
let run: HeadlessRun;
let sandboxState: string;
let threads: ThreadsService;
const runHeadless = vi.fn(async (): Promise<HeadlessRun> => run);
const abort = vi.fn(async () => undefined);
let dialogs: { id: string; request: { method: string; title: string; message?: string } }[];
let resumed: HeadlessRun;
const resumeHeadless = vi.fn(async (): Promise<HeadlessRun> => resumed);
const pendingDialogs = vi.fn(() => dialogs);
let readOnly: ((threadId: string) => Promise<string | undefined>) | undefined;
const setReadOnlyThreads = vi.fn((hook: typeof readOnly) => (readOnly = hook));

const settle = () => vi.waitFor(() => expect(lead.state(roomId)).not.toBe('working'), { timeout: 5000 });

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-room-lead-')));
  project = join(base, 'pi-kit');
  mkdirSync(project);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  db = await DatabaseService.create({ dataDir: join(base, 'data') });
  rows = new ThreadsRepository(db);
  rooms = new RoomsRepository(db);
  const sessionPath = join(base, 'source.jsonl');
  writeFileSync(sessionPath, '{}\n');
  await rows.insertDraft({ id: 'source', sessionPath, cwd: project, baseCommit: null });
  reply = 'I would split this into a Linux test task.';
  run = { status: 'finished' };
  sandboxState = 'active';
  runHeadless.mockClear();
  resumeHeadless.mockClear();
  abort.mockClear();
  dialogs = [];
  resumed = { status: 'finished' };
  let created = 0;
  threads = {
    create: vi.fn(
      async (
        cwd: string,
        title: string,
        _w: unknown,
        _l: unknown,
        options: { onId?: (id: string) => Promise<void> },
      ) => {
        const id = `lead-${++created}`;
        await options.onId?.(id);
        const path = join(base, `${id}.jsonl`);
        writeFileSync(path, '{}\n');
        await rows.insertDraft({ id, sessionPath: path, cwd, title, baseCommit: null });
        return { id };
      },
    ),
    setProtection: vi.fn(async (_id: string, change: { mode: string }) => ({
      mode: change.mode,
      state: change.mode === 'sandboxed' ? sandboxState : 'bypass',
      reason: sandboxState === 'unavailable' ? 'srt missing' : null,
    })),
    protectionOf: vi.fn(async () => ({ mode: 'sandboxed', state: sandboxState, reason: null })),
    treeSource: vi.fn(async () => ({
      entries: [
        { id: 'u', parentId: null, type: 'message', message: { role: 'user', content: 'hi' } },
        {
          id: 'a',
          parentId: 'u',
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
        },
      ],
      leafId: 'a',
      path: undefined,
    })),
  } as unknown as ThreadsService;
  bus = new RoomBus(rooms);
  lead = new RoomLeadService(
    rooms,
    threads,
    { runHeadless, resumeHeadless } as unknown as AguiService,
    { abort, setReadOnlyThreads, pendingDialogs } as unknown as PiSessionService,
    bus,
    new RoomAgents(rows, threads, { mcpAppLookup: () => undefined } as never, new MetaRepository(db)),
    new RoomQuestions(),
    new RoomPlaybooksRepository(db),
    new RoomPlaybookFiles(new RoomFolders({ dataDir: join(base, 'data') } as BackendConfig)),
    { forRooms: async () => undefined } as unknown as ComposioConnectService,
    new RoomLive(bus),
    (runs = new RoomRuns(new RoomRunsRepository(db), bus)),
  );
  const room = await new RoomsService(
    rooms,
    rows,
    new InstanceRepository(db),
    new MetaRepository(db),
    new RoomPlaybookFiles(),
  ).create({
    threadId: 'source',
    title: 'Watcher fix on Linux',
    summary: 'Run the watcher tests on Linux.',
  });
  roomId = room.id;
});

afterEach(async () => {
  await lead.onApplicationShutdown();
  await db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('the room lead', () => {
  it('continues an owner-approved worker result ahead of a disabled proactive wake', async () => {
    lead.setAssistant({
      enabled: async () => true,
      canWake: async () => false,
      briefing: async () => '',
      prepare: async () => project,
    });
    await lead.nudge(roomId, 'Scheduled check', { kind: 'schedule', title: 'Scheduled check' });
    expect(await lead.pending(roomId)).toBe(1);
    expect(runHeadless).not.toHaveBeenCalled();
    await lead.nudge(roomId, 'Worker finished', { kind: 'agent', title: 'Worker finished' });
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(1));
    await settle();
    expect((runHeadless.mock.calls[0] as unknown as [string, string])[1]).toContain('Worker finished');
    expect(await lead.pending(roomId)).toBe(1);
    expect((await rooms.nextWake(roomId))?.cause.kind).toBe('schedule');
  });
  it('gives a personal assistant prompt without coding-worker delegation and permits owned outputs', async () => {
    const personal = await rooms.insert({
      id: '27f5d2ca-8608-4c92-bf71-a011a7b7f966',
      title: 'Personal',
      repository: '',
      baseCommit: '',
      summary: 'Help me plan tomorrow.',
      sourceThreadId: null,
      projectFolder: null,
      createdAt: Date.now(),
    });
    lead.setAssistant({
      enabled: async () => true,
      canWake: async () => false,
      briefing: async () => '',
      prepare: async () => project,
    });
    await lead.post(personal.id, { text: 'Prepare a brief.', route: 'lead' });
    await vi.waitFor(() => expect(lead.state(personal.id)).toBe('idle'));
    const prompt = (runHeadless.mock.calls[0] as unknown as [string, string])[1];
    expect(prompt).toContain('personal assistant');
    expect(prompt).not.toContain('room_propose_task');
    expect(prompt).toContain('action="output"');
    expect(prompt).toContain('Help me plan tomorrow.');
  });
  it('preserves an owner message paused while its workspace is being prepared', async () => {
    let release: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    lead.setAssistant({
      enabled: async () => true,
      canWake: async () => true,
      briefing: async () => '',
      prepare: async () => {
        await prepared;
        return project;
      },
    });
    await lead.post(roomId, { text: 'Hold this message', route: 'lead' });
    await rooms.setPaused(roomId, true);
    release();
    await settle();
    expect(runHeadless).not.toHaveBeenCalled();
    expect(await rooms.pendingWakes(roomId)).toBe(1);
    await lead.update(roomId, { paused: false });
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(1));
    await settle();
    expect((await rooms.events(roomId)).filter((event) => event.actor === 'owner')).toHaveLength(1);
  });
  it('makes every room lead a read-only session that asks its owner, and only leads', async () => {
    await lead.onModuleInit();
    const leadId = await lead.prepare(roomId);
    expect(await readOnly?.(leadId)).toBe('ask-owner');
    expect(await readOnly?.('source')).toBeUndefined();
  });

  it.each(['room chat', 'messaging channel'] as const)(
    'makes automatic room memory available in normal %s without a remember command',
    async (source) => {
      const notes = new RoomPlaybooksRepository(db),
        policy = new RoomAssistantRepository(db),
        meta = new MetaRepository(db);
      await meta.setSetting(ROOMS_SETTING_KEY, true);
      const workspace = {
        prepare: async () => project,
        execution: async () => ({ cwd: project, workspace: false, sandbox: false }),
        path: () => project,
        list: async () => [],
        files: async () => [],
      } as unknown as RoomWorkspace;
      const assistant = new RoomAssistant(policy, notes, rooms, lead, workspace, bus, new RoomMemory(notes, bus));
      lead.setAssistant(assistant);
      const preference = 'I prefer concise replies with practical examples.';
      runHeadless.mockImplementationOnce(async () => {
        const [thread, prompt] = runHeadless.mock.calls[0] as unknown as [string, string];
        expect(prompt).toContain(preference);
        expect(prompt).toContain('Automatically maintain useful memory during ordinary room conversations');
        expect(prompt).toContain('without requiring a remember command, form, or separate request');
        expect(prompt).toContain('never overwrite a correction with older conversation history');
        // Simulate the normal model choosing its registered memory tool, without an extra model pass.
        await assistant.command(thread, {
          action: 'remember',
          key: 'reply-style',
          text: 'Prefer concise replies with practical examples.',
        });
        return { status: 'finished' };
      });
      let phone: RoomPhoneService | undefined;
      try {
        if (source === 'room chat') await lead.post(roomId, { text: preference, route: 'lead' });
        else {
          const store = new RoomPhoneRepository(db);
          const wire: RoomMessagingTransport = {
            phase: 'connected',
            qr: null,
            error: null,
            account: 'assistant-account',
            input: { lastGroupAt: null, lastOwnGroupAt: null, lastAcceptedAt: null, ignoredHistory: 0 },
            receive: async () => undefined,
            receipt: async () => undefined,
            connect: async () => undefined,
            disconnect: async () => undefined,
            createMessageId: () => crypto.randomUUID(),
            send: async () => 'sent',
            media: async () => new Uint8Array(),
          };
          const group = 'baileys:personal@g.us',
            owner = 'phone-owner',
            code = 'a'.repeat(24);
          await store.begin(roomId, code, Date.now() + 600000);
          await store.candidate(code, group, owner, 'Owner', 'Personal', Date.now());
          await store.confirm(roomId, group, owner, 'assistant-account', Date.now());
          phone = new RoomPhoneService(
            store,
            rooms,
            lead,
            wire,
            meta,
            assistant,
            policy,
            workspace,
            {} as TranscribeService,
            notes,
            {} as RoomPlaybookService,
          );
          await phone.onModuleInit();
          await wire.receive({
            id: 'ordinary-owner-message',
            group,
            sender: owner,
            senderName: 'Owner',
            groupName: 'Personal',
            text: preference,
          });
          await phone.flush();
        }
        await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(1));
        await settle();
        expect((await assistant.status(roomId)).memory).toMatchObject([
          { key: 'reply-style', text: 'Prefer concise replies with practical examples.', updatedBy: 'lead' },
        ]);
        expect((await rooms.events(roomId)).filter((event) => event.actor === 'owner')).toHaveLength(1);
        expect(await notes.memory(['room:unrelated'])).toEqual([]);
      } finally {
        await phone?.onApplicationShutdown();
        await assistant.onApplicationShutdown();
      }
    },
  );

  it('creates the lead on the first message, seeds it with the summary, and posts its answer', async () => {
    const lines: RoomStreamLine[] = [];
    bus.subscribe(roomId, (line) => lines.push(line));
    await lead.post(roomId, { text: 'Can Desktop check this on Linux?', route: 'lead' });
    expect(lead.state(roomId)).toBe('working');
    await settle();
    const prompt = runHeadless.mock.calls[0] as unknown as [string, string, { cwd: string }];
    expect(prompt[0]).toBe('lead-1');
    expect(prompt[1]).toContain('Run the watcher tests on Linux.');
    expect(prompt[1]).toContain('Can Desktop check this on Linux?');
    expect(prompt[2].cwd).toBe(project);
    const detail = await lead.detail(roomId);
    expect(detail.lead).toBe('idle');
    expect(detail.events.map((e) => [e.seq, e.actor, e.text])).toEqual([
      [1, 'owner', 'Can Desktop check this on Linux?'],
      [2, 'lead', reply],
    ]);
    expect(
      lines
        .filter((l) => l.type !== 'run' && l.type !== 'live')
        .map((l) => (l.type === 'lead' ? l.state : l.type === 'event' ? l.event.actor : 'task')),
    ).toEqual(['owner', 'working', 'lead', 'idle']);
    await vi.waitFor(() =>
      expect(lines.flatMap((l) => (l.type === 'run' ? [l.run.state] : []))).toEqual(['running', 'done']),
    );
    expect(await runs.list(roomId)).toEqual([
      expect.objectContaining({
        number: 1,
        cause: 'owner',
        title: 'Can Desktop check this on Linux?',
        state: 'done',
        summary: reply,
        steps: [],
      }),
    ]);
    await lead.nudge(roomId, 'Desktop finished.\nDetails follow.');
    await settle();
    expect((await runs.list(roomId)).map((run) => [run.number, run.cause, run.title])).toEqual([
      [2, 'agent', 'Desktop finished.'],
      [1, 'owner', 'Can Desktop check this on Linux?'],
    ]);
  });

  it('streams what the lead writes and ends the stream before its answer is posted', async () => {
    runHeadless.mockImplementationOnce((async (
      _thread: string,
      _prompt: string,
      options: { observe?: (event: { type: string; delta?: string }) => void },
    ) => {
      options.observe?.({ type: 'TEXT_MESSAGE_START' });
      options.observe?.({ type: 'TEXT_MESSAGE_CONTENT', delta: 'I would split ' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      options.observe?.({ type: 'TEXT_MESSAGE_CONTENT', delta: 'this.' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      return run;
    }) as never);
    const lines: RoomStreamLine[] = [];
    bus.subscribe(roomId, (line) => lines.push(line));
    await lead.post(roomId, { text: 'Plan it.', route: 'lead' });
    await vi.waitFor(() => expect(lead.state(roomId)).toBe('idle'), { timeout: 3000 });
    await settle();
    const told = lines.flatMap((line) =>
      line.type === 'live'
        ? [line.live.done ? 'live done' : `live ${line.live.reset ? 'whole' : 'more'}: ${line.live.text}`]
        : line.type === 'event' && line.event.actor === 'lead'
          ? ['answer']
          : [],
    );
    expect(told).toEqual(['live whole: ', 'live whole: I would split ', 'live more: this.', 'live done', 'answer']);
  });

  it('starts the lead on the host while rooms do not use the sandbox', async () => {
    await lead.prepare(roomId);
    expect(threads.setProtection).not.toHaveBeenCalled();
  });

  it('delegates cwd selection to the workspace execution policy without setting another sandbox policy', async () => {
    const cwd = join(base, 'selected-room-workspace');
    const initialCwd = vi.fn(async () => cwd);
    lead.setAssistant({
      initialCwd,
      prepare: async () => cwd,
      briefing: async () => undefined,
      enabled: async () => true,
      canWake: async () => true,
    });
    await lead.prepare(roomId);
    expect(initialCwd).toHaveBeenCalledWith(expect.objectContaining({ room: expect.objectContaining({ id: roomId }) }));
    expect(threads.setProtection).not.toHaveBeenCalled();
  });

  it('passes images to the lead and records how many came with the message', async () => {
    const images = [
      { mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' },
      { mimeType: 'image/jpeg' as const, data: '/9j/4AAQ' },
    ];
    const event = await lead.post(roomId, { text: 'What is wrong here?', route: 'lead', images });
    expect(event.images).toBe(2);
    await settle();
    const call = runHeadless.mock.calls[0] as unknown as [string, string, { images: unknown }];
    expect(call[2].images).toEqual(images);
    expect((await lead.detail(roomId)).events[0].images).toBe(2);
  });

  it('reuses the lead and sends later messages as they are', async () => {
    await lead.post(roomId, { text: 'First', route: 'lead' });
    await settle();
    await lead.post(roomId, { text: 'Second', route: 'lead' });
    await settle();
    const calls = runHeadless.mock.calls as unknown as [string, string][];
    expect(calls.map((c) => c[0])).toEqual(['lead-1', 'lead-1']);
    expect(calls[1][1]).toBe('Second');
  });

  it('keeps the lead out of the thread list', async () => {
    await lead.post(roomId, { text: 'Hello', route: 'lead' });
    await settle();
    expect((await rows.list()).map((row) => row.id)).toEqual(['source']);
    expect((await rows.visible()).map((row) => row.id)).toEqual(['source']);
    expect((await rows.all()).map((row) => row.id).sort()).toEqual(['lead-1', 'source']);
  });

  it('keeps consultant threads out of the thread list too', async () => {
    const path = join(base, 'consultant.jsonl');
    writeFileSync(path, '{}\n');
    await rows.insertDraft({ id: 'consultant', sessionPath: path, cwd: project, baseCommit: null });
    await new RoomPlaybooksRepository(db).addConsultThread('consultant', roomId, 'security');
    expect((await rows.list()).map((row) => row.id)).toEqual(['source']);
    expect((await rows.visible()).map((row) => row.id)).toEqual(['source']);
  });

  it('posts notes without prompting and preserves a second owner message while the lead works', async () => {
    await lead.post(roomId, { text: 'A note', route: 'none' });
    expect(runHeadless).not.toHaveBeenCalled();
    let release: (value: HeadlessRun) => void = () => undefined;
    runHeadless.mockImplementationOnce(() => new Promise<HeadlessRun>((resolve) => (release = resolve)));
    await lead.post(roomId, { text: 'Busy?', route: 'lead' });
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalled(), { timeout: 5000 });
    await lead.post(roomId, { text: 'Again', route: 'lead' });
    expect(await lead.pending(roomId)).toBe(1);
    expect((await rooms.events(roomId)).filter((event) => event.actor === 'owner').map((event) => event.text)).toEqual([
      'A note',
      'Busy?',
      'Again',
    ]);
    release({ status: 'finished' });
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(2));
    await settle();
    expect(lead.state(roomId)).toBe('idle');
  });

  it('cancels a turn that stops without a question it can show, and says so', async () => {
    run = { status: 'interrupted' };
    await lead.post(roomId, { text: 'Edit the file', route: 'lead' });
    await settle();
    expect(abort).toHaveBeenCalledWith('lead-1');
    const events = (await lead.detail(roomId)).events;
    expect(events.at(-1)).toMatchObject({ actor: 'coordinator', kind: 'note' });
    expect(lead.state(roomId)).toBe('idle');
  });

  it('asks the owner when the lead stops for an approval and goes on with the answer', async () => {
    run = { status: 'interrupted' };
    dialogs = [{ id: 'd1', request: { method: 'confirm', title: 'Read the logs?', message: 'tail -n 50 app.log' } }];
    const lines: RoomStreamLine[] = [];
    bus.subscribe(roomId, (line) => lines.push(line));
    await lead.post(roomId, { text: 'Why does it crash?', route: 'lead' });
    await vi.waitFor(async () => expect((await lead.detail(roomId)).leadQuestions).toHaveLength(1), { timeout: 5000 });
    const waiting = await lead.detail(roomId);
    expect(waiting.leadQuestions[0]).toMatchObject({ id: 'd1', method: 'confirm', title: 'Read the logs?' });
    expect(waiting.room.waiting).toBe(1);
    expect(waiting.events.at(-1)?.text).toBe('The lead needs you: Read the logs?');
    expect(lines.some((line) => line.type === 'lead' && line.questions?.length === 1)).toBe(true);
    await expect(lead.post(roomId, { text: 'Hello?', route: 'lead' })).rejects.toBeInstanceOf(ConflictException);
    await expect(lead.answerQuestions(roomId, { answers: [{ id: 'other', confirmed: true }] })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const answered = await lead.answerQuestions(roomId, { answers: [{ id: 'd1', confirmed: true }] });
    expect(answered.leadQuestions).toEqual([]);
    await settle();
    expect(resumeHeadless).toHaveBeenCalledWith(
      'lead-1',
      [{ interruptId: 'd1', status: 'resolved', payload: { confirmed: true } }],
      { cwd: project, observe: expect.any(Function) },
    );
    const detail = await lead.detail(roomId);
    expect(detail.events.at(-1)).toMatchObject({ actor: 'lead', text: reply });
    expect(detail.room.waiting).toBe(0);
    expect(abort).not.toHaveBeenCalled();
  });

  it('passes a skipped question on as declined', async () => {
    run = { status: 'interrupted' };
    dialogs = [{ id: 'd1', request: { method: 'input', title: 'Which log file?' } }];
    await lead.post(roomId, { text: 'Look at the logs', route: 'lead' });
    await vi.waitFor(async () => expect((await lead.detail(roomId)).leadQuestions).toHaveLength(1), { timeout: 5000 });
    await lead.answerQuestions(roomId, { answers: [{ id: 'd1', cancelled: true }] });
    await settle();
    expect(resumeHeadless).toHaveBeenCalledWith('lead-1', [{ interruptId: 'd1', status: 'cancelled' }], {
      cwd: project,
      observe: expect.any(Function),
    });
  });

  it('forgets questions nobody can answer after a restart', async () => {
    await rooms.setLeadQuestions(roomId, [{ id: 'd1', method: 'confirm', title: 'Old' }]);
    expect((await lead.detail(roomId)).room.waiting).toBe(1);
    await lead.onModuleInit();
    const detail = await lead.detail(roomId);
    expect(detail.leadQuestions).toEqual([]);
    expect(detail.room.waiting).toBe(0);
  });

  it('queues agent messages behind a busy lead instead of dropping them', async () => {
    let release: (value: HeadlessRun) => void = () => undefined;
    runHeadless.mockImplementationOnce(() => new Promise<HeadlessRun>((resolve) => (release = resolve)));
    await lead.post(roomId, { text: 'Plan it', route: 'lead' });
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await lead.nudge(roomId, 'Result of the task X');
    expect(await lead.pending(roomId)).toBe(1);
    release({ status: 'finished' });
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect((runHeadless.mock.calls[1] as unknown as [string, string])[1]).toBe('Result of the task X');
    await settle();
    expect(await lead.pending(roomId)).toBe(0);
  });

  it('pauses the room when agents wake the lead too often in a row, and resumes on the owner’s word', async () => {
    const lines: RoomStreamLine[] = [];
    bus.subscribe(roomId, (line) => lines.push(line));
    await rooms.setAgentTurns(roomId, RoomLeadService.AGENT_TURN_LIMIT);
    await lead.nudge(roomId, 'One more');
    expect(runHeadless).not.toHaveBeenCalled();
    const detail = await lead.detail(roomId);
    expect(detail.paused).toBe(true);
    expect(detail.events.at(-1)?.text).toContain('Paused');
    expect(lines.some((line) => line.type === 'room' && line.paused)).toBe(true);
    expect((await lead.update(roomId, { paused: false })).paused).toBe(false);
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await settle();
  });

  it('gives the room its own folder, renames it and archives it without deleting anything', async () => {
    const detail = await lead.detail(roomId);
    expect(detail.folder).toBe(join(base, 'data', 'rooms', roomId));
    expect(existsSync(join(detail.folder as string, 'playbooks'))).toBe(true);
    const lines: unknown[] = [];
    bus.subscribe(roomId, (line) => lines.push(line));
    const renamed = await lead.update(roomId, { title: 'Watcher fix everywhere' });
    expect(renamed.room.title).toBe('Watcher fix everywhere');
    expect(renamed.events.at(-1)?.text).toContain('Watcher fix everywhere');
    expect(lines.at(-1)).toMatchObject({ type: 'room', title: 'Watcher fix everywhere' });
    expect((await rooms.active()).map((room) => room.title)).toEqual(['Watcher fix everywhere']);
    await lead.archive(roomId);
    expect(await rooms.active()).toEqual([]);
    await expect(lead.detail(roomId)).rejects.toThrow('No room with this id');
    expect(existsSync(join(detail.folder as string, 'playbooks'))).toBe(true);
  });

  it('switches the room to assisted and says so in the room', async () => {
    const detail = await lead.update(roomId, { mode: 'assisted' });
    expect(detail.mode).toBe('assisted');
    expect(detail.events.at(-1)?.text).toContain('Assisted');
  });

  it('reports a failed turn', async () => {
    run = { status: 'error', error: 'No model.' };
    await lead.post(roomId, { text: 'Hello', route: 'lead' });
    await settle();
    expect((await lead.detail(roomId)).events.at(-1)?.text).toBe('The lead could not answer: No model.');
    expect(lead.state(roomId)).toBe('error');
  });
});

describe('the room’s playbook', () => {
  const playbook = (name: string, stages: string) => {
    const folder = join(project, '.pi', 'skills', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} work.\n---\nDo ${name}.\n`);
    writeFileSync(join(folder, 'room.yaml'), `stages: [${stages}]\n`);
  };

  beforeEach(() => {
    playbook('triage', 'collect, decide');
    playbook('release', 'freeze, ship');
    lead.setPlaybooks({
      briefing: async (found) => (found.playbook ? `Briefing of ${found.playbook}.` : undefined),
      extras: async () => ({ stages: [], actions: [], memory: [] }),
      settings: async () => undefined,
    });
  });

  it('lists the playbooks of the room’s own folder', async () => {
    expect((await lead.roomPlaybooks(roomId)).map((p) => p.name).sort()).toEqual(['release', 'triage']);
  });

  it('attaches, switches and removes a playbook, each at its first stage and with a note', async () => {
    let detail = await lead.update(roomId, { playbook: 'triage' });
    expect([detail.playbook, detail.stage, detail.mode]).toEqual(['triage', 'collect', 'assisted']);
    detail = await lead.update(roomId, { playbook: 'release' });
    expect([detail.playbook, detail.stage]).toEqual(['release', 'freeze']);
    detail = await lead.update(roomId, { playbook: null });
    expect([detail.playbook, detail.stage]).toEqual([null, null]);
    expect(detail.events.filter((e) => e.kind === 'note').map((e) => e.text)).toEqual([
      'You attached the playbook “triage”: the room is Assisted and at its first stage “collect”.',
      'You attached the playbook “release”: the room is Assisted and at its first stage “freeze”.',
      'You removed the playbook.',
    ]);
  });

  it('refuses a playbook that is missing, and any change while the lead answers', async () => {
    await expect(lead.update(roomId, { playbook: 'nope' })).rejects.toBeInstanceOf(ConflictException);
    await lead.post(roomId, { text: 'Start.', route: 'lead' });
    await expect(lead.update(roomId, { playbook: 'triage' })).rejects.toThrow(LEAD_BUSY);
    await settle();
  });

  it('briefs the lead on the new playbook with its next prompt, once', async () => {
    await lead.post(roomId, { text: 'Start.', route: 'lead' });
    await settle();
    await lead.update(roomId, { playbook: 'triage' });
    await lead.post(roomId, { text: 'Go on.', route: 'lead' });
    await settle();
    await lead.post(roomId, { text: 'And then?', route: 'lead' });
    await settle();
    const prompts = runHeadless.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    expect(prompts.at(-2)).toBe('Briefing of triage.\n\nGo on.');
    expect(prompts.at(-1)).toBe('And then?');
  });
});
