import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendMessageRequest, StreamResponse, Task } from '@a2a-js/sdk';
import { A2A_ROOM_EXTENSION, A2aRoomConsultSchema, type RoomStreamLine } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { InstanceRepository } from '../db/instance.repository';
import { MetaRepository } from '../db/meta.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PeersService } from '../peers/peers.service';
import type { RoomAgents } from './room-agents';
import type { RoomA2aAgents } from './room-a2a-agents';
import type { RoomA2aClient } from './room-a2a.client';
import { RoomBus } from './room-bus';
import { RoomMemory } from './room-memory';
import type { PiSessionService } from '../pi/pi-session.service';
import { RoomPlaybookTools } from './room-playbook-tools.service';
import type { RoomConsultant } from './room-consultant.service';
import type { RoomLeadService } from './room-lead.service';
import { McpCallService } from '../mcp/mcp-call.service';
import { RoomSources } from './room-sources.service';
import { RoomPlaybookService } from './room-playbook.service';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomFolders } from './room-folders';
import { RoomLive } from './room-live';
import { RoomRuns } from './room-runs';
import { RoomRunsRepository } from '../db/room-runs.repository';
import type { BackendConfig } from '../app/config';
import { RoomPlaybookEditor } from './room-playbook-editor.service';
import type { RoomEnvironments } from './room-environments';
import { RoomsService } from './rooms.service';

vi.mock('../pi/load-pi', () => {
  const pi = (file: string) =>
    import(join(process.cwd(), '../../node_modules/@earendil-works/pi-coding-agent/dist', file));
  return {
    loadPi: () => import('@earendil-works/pi-coding-agent'),
    loadPiMcp: () => import('@earendil-works/pi-mcp'),
    loadPiInternals: async () => ({
      oauth: await pi('extensions/mcp/oauth.js'),
      config: await pi('core/resolve-config-value.js'),
    }),
  };
});

const SKILL = `---
name: pr-review
description: Review pull requests.
metadata:
  pi-kit-room: room.yaml
---
Review every pull request the trigger brings.
`;

const ROOM = `participants:
  - role: security
    instructions: Look for injection and secrets.
  - role: tests
    instructions: Look for missing tests.
tools:
  open_prs:
    run: [node, -e, "console.log(JSON.stringify([{number: 1, head: 'a'}, {number: 2, head: 'b'}]))"]
    description: Open pull requests.
  show:
    run: [node, -e, "console.log('pr ' + process.argv[1])", "{pr}"]
    description: Show one pull request.
  long:
    run: [node, -e, "console.log('x'.repeat(60000) + 'END')"]
  issue:
    mcp: { server: tracker, tool: get_issue, args: { id: "{ticket}", full: true } }
    description: Read one ticket.
  agenda:
    calendar: { ics: calendar.ics, days: 2 }
    description: The next two days.
safe-outputs:
  comment:
    run: [node, -e, "console.log('posted ' + process.argv[1])", "{pr}"]
    description: Post a review.
    max: 2
  label:
    run: [node, -e, "console.log('labeled ' + process.argv[1])", "{pr}"]
    mode: auto
  close:
    mcp: { server: tracker, tool: close_issue, args: { id: "{ticket}" } }
  mail_draft:
    mcp: { server: mail, tool: create_draft, args: { to: "{to}" } }
on:
  schedule:
    - id: brief
      cron: "0 8 * * 1-5"
      say: Write the morning brief.
  poll:
    - id: prs
      every: 1m
      tool: open_prs
      key: [number, head]
      say: Review each new pull request.
stages: [review, verdict]
gates:
  verdict: owner
`;

let base: string;
let project: string;
let db: DatabaseService;
let rooms: RoomsRepository;
let store: RoomPlaybooksRepository;
let service: RoomPlaybookService;
let nudge: ReturnType<typeof vi.fn>;
let rebriefNext: ReturnType<typeof vi.fn>;
let editor: RoomPlaybookEditor;
let tools: RoomPlaybookTools;
let agents: RoomAgents;
let ask: ReturnType<typeof vi.fn>;
let roomId: string;
let agentDir: string;
let runs: RoomRuns;
let bus: RoomBus;
let paired: { peerId: string; name: string; state: string }[];
const a2a = { sendMessage: vi.fn(), getTask: vi.fn(), subscribe: vi.fn() };

const MCP_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tracker', version: '1' } } });
  else if (message.method === 'tools/call')
    send({ id: message.id, result: { content: [{ type: 'text', text: message.params.name + ' ' + JSON.stringify(message.params.arguments) + ' ' + process.env.TRACKER_HELLO }] } });
  else if (message.id !== undefined) send({ id: message.id, result: {} });
});
`;

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], {
    encoding: 'utf8',
  }).trim();

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-playbook-')));
  project = join(base, 'pi-kit');
  mkdirSync(join(project, '.pi', 'skills', 'pr-review'), { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(project, '.pi', 'skills', 'pr-review', 'SKILL.md'), SKILL);
  writeFileSync(join(project, '.pi', 'skills', 'pr-review', 'room.yaml'), ROOM);
  agentDir = join(base, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(base, 'tracker.js'), MCP_SERVER);
  writeFileSync(
    join(agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        tracker: { command: process.execPath, args: [join(base, 'tracker.js')], env: { TRACKER_HELLO: '${PK_HELLO}' } },
        mail: { url: 'http://127.0.0.1:9/mcp', oauth: { clientId: 'mine', callbackPort: 8766 } },
      },
    }),
  );
  process.env['PK_HELLO'] = 'hi';
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  db = await DatabaseService.create({ dataDir: join(base, 'data') });
  rooms = new RoomsRepository(db);
  store = new RoomPlaybooksRepository(db);
  const meta = new MetaRepository(db);
  await meta.touchWorkspace(project);
  nudge = vi.fn(async () => undefined);
  ask = vi.fn(async (request: { role: string; question: string }) => `${request.role} says fine`);
  rebriefNext = vi.fn();
  const mcp = new McpCallService({ agentDir: async () => agentDir } as unknown as PiSessionService);
  const files = new RoomPlaybookFiles(new RoomFolders({ dataDir: join(base, 'data') } as BackendConfig));
  tools = new RoomPlaybookTools(mcp, new RoomSources());
  bus = new RoomBus(rooms);
  paired = [];
  const lead = {
    nudge,
    rebriefNext,
    resumePending: vi.fn(async () => undefined),
    setPlaybooks: () => undefined,
  } as unknown as RoomLeadService;
  agents = {
    projectFolder: async () => project,
    models: async () => [
      { provider: 'anthropic', id: 'claude-opus-5-5', reasoning: true },
      { provider: 'local', id: 'gemma', reasoning: false },
    ],
  } as unknown as RoomAgents;
  editor = new RoomPlaybookEditor(
    rooms,
    store,
    files,
    tools,
    bus,
    lead,
    agents,
    { list: async () => [] } as unknown as RoomEnvironments,
    mcp,
  );
  service = new RoomPlaybookService(
    rooms,
    store,
    files,
    tools,
    { ask } as unknown as RoomConsultant,
    bus,
    lead,
    agents,
    a2a as unknown as RoomA2aClient,
    { list: async () => [] } as unknown as RoomA2aAgents,
    { manager: async () => ({ self: { name: 'Here' }, peers: paired }) } as unknown as PeersService,
    editor,
    new RoomLive(bus),
    new RoomMemory(store, bus),
    (runs = new RoomRuns(new RoomRunsRepository(db), bus)),
  );
  const room = await new RoomsService(
    rooms,
    new ThreadsRepository(db),
    new InstanceRepository(db),
    meta,
    new RoomPlaybookFiles(),
  ).create({
    repository: 'pi-kit',
    baseCommit: git('rev-parse', 'HEAD'),
    title: 'Reviews',
    summary: '',
    playbook: 'pr-review',
  });
  roomId = room.id;
  await rooms.setLead(roomId, 'lead');
});

afterEach(async () => {
  delete process.env['PI_CODING_AGENT_DIR'];
  service.onApplicationShutdown();
  await db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('room playbooks', () => {
  it('lists skills with a room block as playbooks and starts the room assisted at the first stage', async () => {
    expect(new RoomPlaybookFiles().list({ project })).toEqual([
      expect.objectContaining({
        name: 'pr-review',
        roles: ['security', 'tests'],
        tools: ['open_prs', 'show', 'long', 'issue', 'agenda'],
        outputs: ['comment', 'label', 'close', 'mail_draft'],
        triggers: 2,
        stages: ['review', 'verdict'],
        error: null,
      }),
    ]);
    const found = await rooms.get(roomId);
    expect(found).toMatchObject({ playbook: 'pr-review', stage: 'review', mode: 'assisted' });
    expect(await service.briefing(found!)).toContain('room_consult');
  });

  it('reports a playbook that does not parse instead of hiding it, and skips skills without room.yaml', () => {
    const room = join(project, '.pi', 'skills', 'pr-review', 'room.yaml');
    writeFileSync(
      room,
      'on:\n  poll:\n    - { id: t, every: 1m, tool: comment }\nsafe-outputs:\n  comment: { run: [x] }\n',
    );
    expect(new RoomPlaybookFiles().list({ project })[0]?.error).toContain('safe outputs never run from a trigger');
    writeFileSync(room, 'on:\n  schedule:\n    - { id: t, cron: "99 * * * *" }\n');
    expect(new RoomPlaybookFiles().list({ project })[0]?.error).toContain('cron');
    writeFileSync(room, 'connectors: {}\n');
    expect(new RoomPlaybookFiles().list({ project })[0]?.error).toContain('connectors');
    rmSync(room);
    expect(new RoomPlaybookFiles().list({ project })).toEqual([]);
  });

  it('runs tools at once, drafts safe outputs, and refuses what the playbook does not name', async () => {
    expect(await service.call('lead', { tool: 'show', params: { pr: '7' }, reason: 'Read it.' })).toBe('pr 7');
    await expect(service.call('lead', { tool: 'merge', params: {}, reason: 'Merge.' })).rejects.toThrow('no tool');
    const drafted = await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    expect(drafted).toContain('Nothing ran');
    const [action] = await store.actions(roomId);
    expect(action).toMatchObject({ kind: 'call', name: 'comment', state: 'pending' });
    const done = await service.decide(roomId, action!.id, { decision: 'approve' });
    expect(done).toMatchObject({ state: 'done', result: 'posted 7' });
    expect(nudge).toHaveBeenCalledWith(
      roomId,
      expect.stringContaining('posted 7'),
      {
        kind: 'approval',
        title: 'You approved comment; it ran.',
      },
      `action:${action!.id}`,
    );
    await expect(service.decide(roomId, action!.id, { decision: 'discard' })).rejects.toThrow('decided already');
  });

  it('rolls back the decision and events when durable continuation fails, then queues one continuation', async () => {
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const [action] = await store.actions(roomId);
    const before = (await rooms.events(roomId)).length;
    const fault = vi.spyOn(rooms, 'enqueueWake').mockRejectedValueOnce(new Error('disk fault'));
    await expect(service.decide(roomId, action!.id, { decision: 'discard' })).rejects.toThrow('disk fault');
    expect((await store.action(roomId, action!.id))?.state).toBe('pending');
    expect((await rooms.events(roomId)).length).toBe(before);
    fault.mockRestore();
    await service.decide(roomId, action!.id, { decision: 'discard' });
    expect(await rooms.wakeBySource(roomId, `action:${action!.id}`)).toMatchObject({ state: 'queued' });
  });

  it('settles a saved external outcome after an enqueue fault without executing the tool twice', async () => {
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const [action] = await store.actions(roomId);
    const fault = vi.spyOn(rooms, 'enqueueWake').mockRejectedValueOnce(new Error('disk fault'));
    await expect(service.decide(roomId, action!.id, { decision: 'approve' })).rejects.toThrow('disk fault');
    expect((await store.execution(roomId, action!.id))?.settlement).toMatchObject({
      state: 'done',
      result: 'posted 7',
    });
    // Make a second external invocation observable: the recorded payload would now fail.
    await db.db.prepare('UPDATE room_actions SET payload_json=? WHERE id=?').run('{}', action!.id);
    fault.mockRestore();
    expect(await service.decide(roomId, action!.id, { decision: 'approve' })).toMatchObject({
      state: 'done',
      result: 'posted 7',
    });
    expect(await rooms.pendingWakes(roomId)).toBe(1);
  });

  it('recovers an ambiguous approved operation as failed without executing it after restart', async () => {
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const [action] = await store.actions(roomId);
    expect(await store.claimExecution(roomId, action!.id)).toBe(true);
    await expect(service.decide(roomId, action!.id, { decision: 'discard' })).rejects.toThrow('already be executing');
    await db.db.prepare('UPDATE room_actions SET payload_json=? WHERE id=?').run('{}', action!.id);
    await service.onModuleInit();
    expect(await store.action(roomId, action!.id)).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('unknown'),
    });
    expect(await rooms.wakeBySource(roomId, `action:${action!.id}`)).toMatchObject({ state: 'queued' });
    await expect(service.decide(roomId, action!.id, { decision: 'approve' })).rejects.toThrow('decided already');
  });

  it('does not let a stale discard overwrite an approval reservation while its tool is running', async () => {
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const action = (await store.actions(roomId))[0];
    if (!action) throw new Error('Missing fixture action.');
    let sawUnclaimed!: () => void;
    let resumeDiscard!: () => void;
    let toolStarted!: () => void;
    let finishTool!: () => void;
    const readDone = new Promise<void>((resolve) => {
      sawUnclaimed = resolve;
    });
    const releaseDiscard = new Promise<void>((resolve) => {
      resumeDiscard = resolve;
    });
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const toolResult = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const execution = store.execution.bind(store);
    vi.spyOn(store, 'execution').mockImplementationOnce(async (...args) => {
      const previous = await execution(...args);
      expect(previous).toBeUndefined();
      sawUnclaimed();
      await releaseDiscard;
      return previous;
    });
    const run = vi.spyOn(tools, 'run').mockImplementationOnce(async () => {
      toolStarted();
      await toolResult;
      return { ok: true, output: 'External post completed.' };
    });
    const discard = service.decide(roomId, action.id, { decision: 'discard' });
    const rejected = expect(discard).rejects.toThrow('already be executing');
    await readDone;
    const approval = service.decide(roomId, action.id, { decision: 'approve' });
    await started;
    resumeDiscard();
    await rejected;
    expect((await store.execution(roomId, action.id))?.settlement).toBeNull();
    expect((await store.action(roomId, action.id))?.state).toBe('pending');
    finishTool();
    expect(await approval).toMatchObject({ state: 'done', result: 'External post completed.' });
    expect((await store.execution(roomId, action.id))?.settlement).toMatchObject({
      state: 'done',
      result: 'External post completed.',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('atomically discards an unclaimed action so a competing approval never starts its external tool', async () => {
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const action = (await store.actions(roomId))[0];
    if (!action) throw new Error('Missing fixture action.');
    const run = vi.spyOn(tools, 'run');
    expect(await service.decide(roomId, action.id, { decision: 'discard' })).toMatchObject({ state: 'discarded' });
    expect(await store.claimExecution(roomId, action.id)).toBe(false);
    await expect(service.decide(roomId, action.id, { decision: 'approve' })).rejects.toThrow('decided already');
    expect(await store.execution(roomId, action.id)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['tool', 'editor', 'cwd'] as const)(
    'settles an unexpected %s failure immediately without replaying the approved operation',
    async (kind) => {
      if (kind !== 'editor') await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
      const action =
        kind === 'editor'
          ? await store.insertAction({
              id: randomUUID(),
              roomId,
              kind: 'playbook',
              name: 'playbook-edit',
              summary: 'Apply the approved edit',
              payload: {},
            })
          : (await store.actions(roomId))[0];
      if (!action) throw new Error('Missing fixture action.');
      const run = vi.spyOn(tools, 'run');
      const apply = vi.spyOn(editor, 'apply');
      const fail = async () => {
        expect((await store.execution(roomId, action.id))?.settlement).toBeNull();
        throw new Error('Unexpected provider error with private details');
      };
      if (kind === 'tool') run.mockImplementationOnce(fail);
      else if (kind === 'editor') apply.mockImplementationOnce(fail);
      else vi.spyOn(agents, 'projectFolder').mockImplementationOnce(fail);
      const decided = await service.decide(roomId, action.id, { decision: 'approve' });
      expect(decided).toMatchObject({
        state: 'failed',
        result: expect.stringContaining(kind === 'cwd' ? 'No external operation was started' : 'outcome is unknown'),
      });
      expect(decided.result).not.toContain('private details');
      expect((await store.execution(roomId, action.id))?.settlement).toMatchObject({
        state: 'failed',
        result: decided.result,
      });
      expect(await rooms.wakeBySource(roomId, `action:${action.id}`)).toMatchObject({ state: 'queued' });
      expect(nudge).toHaveBeenCalledWith(
        roomId,
        expect.stringContaining('Never repeat it automatically'),
        expect.any(Object),
        `action:${action.id}`,
      );
      await expect(service.decide(roomId, action.id, { decision: 'approve' })).rejects.toThrow('decided already');
      await service.onModuleInit();
      expect(run).toHaveBeenCalledTimes(kind === 'tool' ? 1 : 0);
      expect(apply).toHaveBeenCalledTimes(kind === 'editor' ? 1 : 0);
    },
  );

  it('keeps the first journaled outcome when another settlement attempts to overwrite it', async () => {
    const action = await store.insertAction({
      id: randomUUID(),
      roomId,
      kind: 'call',
      name: 'reserved',
      summary: 'Reserved',
      payload: {},
    });
    await store.claimExecution(roomId, action.id);
    const first = { state: 'done' as const, result: 'confirmed', note: 'Confirmed result', nudge: 'Tell the owner.' };
    expect(await store.saveExecution(action.id, first)).toEqual(first);
    expect(
      await store.saveExecution(action.id, { state: 'failed', result: 'competing', note: 'Wrong', nudge: 'Wrong' }),
    ).toEqual(first);
    await expect(
      store.saveExecution(action.id, { state: 'discarded', result: null, note: 'Wrong', nudge: 'Wrong' }),
    ).rejects.toThrow('not an external execution outcome');
    expect(await store.decide(roomId, action.id, 'discarded', null)).toBe(false);
  });

  it('keeps room_note playbook memory private between personal rooms with the same playbook name', async () => {
    const create = async (id: string, lead: string) => {
      await rooms.insert({
        id,
        title: 'Personal',
        repository: '',
        baseCommit: '',
        summary: '',
        sourceThreadId: null,
        projectFolder: null,
        playbook: 'pr-review',
        createdAt: 1,
      });
      await rooms.setLead(id, lead);
      const found = await rooms.get(id);
      if (!found) throw new Error('Missing fixture room.');
      return found;
    };
    const first = await create(randomUUID(), 'personal-lead-a');
    const second = await create(randomUUID(), 'personal-lead-b');
    await service.note('personal-lead-a', {
      key: 'private-fact',
      text: 'Only the first room knows this.',
      scope: 'playbook',
    });
    expect((await service.extras(first)).memory).toEqual([
      expect.objectContaining({ key: 'private-fact', text: 'Only the first room knows this.' }),
    ]);
    expect((await service.extras(second)).memory).toEqual([]);
  });

  it('recovers an invalid legacy discarded journal as unknown owner review without blocking startup or running the action', async () => {
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const action = (await store.actions(roomId))[0];
    if (!action) throw new Error('Missing fixture action.');
    await store.claimExecution(roomId, action.id);
    await db.db
      .prepare('UPDATE room_action_executions SET settlement_json=? WHERE action_id=?')
      .run(
        JSON.stringify({ state: 'discarded', result: null, note: 'Old raced discard', nudge: 'Discarded' }),
        action.id,
      );
    const run = vi.spyOn(tools, 'run');
    await service.onModuleInit();
    expect(await store.action(roomId, action.id)).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('unknown'),
    });
    expect((await store.execution(roomId, action.id))?.settlement).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('unknown'),
    });
    expect(await rooms.wakeBySource(roomId, `action:${action.id}`)).toMatchObject({ state: 'queued' });
    expect(run).not.toHaveBeenCalled();
    await expect(service.decide(roomId, action.id, { decision: 'approve' })).rejects.toThrow('decided already');
  });

  it('hands a long output over a page at a time', async () => {
    const first = await service.call('lead', { tool: 'long', params: {}, reason: 'Read it.' });
    expect(first).toContain('Page 1 of 2');
    expect(first).not.toContain('END');
    const second = await service.call('lead', { tool: 'long', params: {}, reason: 'Read it.', page: 2 });
    expect(second).toContain('END');
    expect(second).toContain('Page 2 of 2.');
    expect((await rooms.events(roomId)).filter((event) => event.text.startsWith('Ran long'))).toHaveLength(1);
  });

  it('calls MCP tools of the user’s servers as connectors', async () => {
    expect(await service.call('lead', { tool: 'issue', params: { ticket: 'T-1' }, reason: 'Read it.' })).toBe(
      'get_issue {"id":"T-1","full":true} hi',
    );
    await service.call('lead', { tool: 'close', params: { ticket: 'T-1' }, reason: 'Done.' });
    const [action] = await store.actions(roomId);
    expect(action?.payload).toMatchObject({ mcp: { server: 'tracker', tool: 'close_issue', args: { id: 'T-1' } } });
    expect(await service.decide(roomId, action!.id, { decision: 'approve' })).toMatchObject({
      state: 'done',
      result: 'close_issue {"id":"T-1"} hi',
    });
  });

  it('uses a server signed in with OAuth only once it is signed in', async () => {
    await service.call('lead', { tool: 'mail_draft', params: { to: 'a@example.com' }, reason: 'Reply.' });
    const action = (await store.actions(roomId)).find((candidate) => candidate.name === 'mail_draft');
    expect(await service.decide(roomId, action!.id, { decision: 'approve' })).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('mail is not signed in yet'),
    });
  });

  it('runs a safe output marked auto at once and keeps to its daily limit', async () => {
    expect(await service.call('lead', { tool: 'label', params: { pr: '7' }, reason: 'Label it.' })).toBe('labeled 7');
    expect((await store.actions(roomId))[0]).toMatchObject({ name: 'label', state: 'done' });
    await service.call('lead', { tool: 'comment', params: { pr: '1' }, reason: 'One.' });
    await service.call('lead', { tool: 'comment', params: { pr: '2' }, reason: 'Two.' });
    expect(await service.call('lead', { tool: 'comment', params: { pr: '3' }, reason: 'Three.' })).toContain(
      'at most 2 times a day',
    );
  });

  it('reads an iCalendar file as a calendar tool', async () => {
    const at = (offset: number) =>
      new Date(Date.now() + offset)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
    writeFileSync(
      join(project, 'calendar.ics'),
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:soon',
        `DTSTART:${at(3_600_000)}`,
        `DTEND:${at(7_200_000)}`,
        'SUMMARY:Design review\\, part 2',
        'LOCATION:Room 4',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:later',
        `DTSTART:${at(10 * 86_400_000)}`,
        'SUMMARY:Too far',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    const events = JSON.parse(await service.call('lead', { tool: 'agenda', params: {}, reason: 'Plan the day.' }));
    expect(events).toEqual([expect.objectContaining({ title: 'Design review, part 2', location: 'Room 4' })]);
  });

  it('wakes the lead on a cron schedule once per matching minute', async () => {
    const monday = new Date(2026, 10, 23, 8, 0, 10).getTime();
    await service.tick(monday);
    await service.tick(monday + 15_000);
    expect(
      (
        await db.db
          .prepare(
            "SELECT count(*) AS n FROM room_wakeups WHERE room_id=? AND json_extract(cause_json,'$.trigger')='brief'",
          )
          .get<{ n: number }>(roomId)
      )?.n,
    ).toBe(1);
    expect((await store.lastRuns(roomId)).get('brief')).toBe(Math.floor(monday / 60_000) * 60_000);
    await service.tick(new Date(2026, 10, 22, 8, 0, 10).getTime());
    expect(
      (
        await db.db
          .prepare(
            "SELECT count(*) AS n FROM room_wakeups WHERE room_id=? AND json_extract(cause_json,'$.trigger')='brief'",
          )
          .get<{ n: number }>(roomId)
      )?.n,
    ).toBe(1);
  });

  it('keeps connector values from becoming options', async () => {
    await expect(service.call('lead', { tool: 'show', params: { pr: '--help' }, reason: 'x' })).rejects.toThrow('dash');
  });

  it('wakes the lead only for items it has not seen, by their key', async () => {
    const sunday = new Date(2026, 10, 22, 12, 0).getTime();
    await service.tick(sunday);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
    expect((await rooms.nextWake(roomId))?.text).toContain('"number":2');
    await service.tick(sunday + 120_000);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
    await rooms.setPaused(roomId, true);
    await service.tick(sunday + 240_000);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
  });

  it('queues every polling item beyond the first five and retains full payloads', async () => {
    const items = Array.from({ length: 7 }, (_, number) => ({
      number,
      head: `head-${number}`,
      detail: number === 6 ? 'tail-' + '.'.repeat(25000) : 'small',
    }));
    writeFileSync(join(project, 'poll-items.json'), JSON.stringify(items));
    writeFileSync(
      join(project, '.pi', 'skills', 'pr-review', 'room.yaml'),
      ROOM.replace(
        "console.log(JSON.stringify([{number: 1, head: 'a'}, {number: 2, head: 'b'}]))",
        "console.log(require('node:fs').readFileSync('poll-items.json','utf8'))",
      ),
    );
    await service.fireNow(roomId, 'prs', false);
    const queued = await db.db
      .prepare('SELECT text FROM room_wakeups WHERE room_id=? ORDER BY created_at,rowid')
      .all<{ text: string }>(roomId);
    expect(queued).toHaveLength(2);
    expect(queued[1].text).toContain('head-6');
    expect(queued[1].text).toContain('tail-' + '.'.repeat(25000));
    expect((await service.fireNow(roomId, 'prs', true)).items.every((item) => !item.fresh)).toBe(true);
  });
  it('does not consume polling seen keys if durable enqueue fails', async () => {
    const enqueue = vi.spyOn(rooms, 'enqueueWake').mockRejectedValueOnce(new Error('Simulated queue failure'));
    await expect(service.fireNow(roomId, 'prs', false)).rejects.toThrow('Simulated queue failure');
    expect(await rooms.pendingWakes(roomId)).toBe(0);
    expect((await service.fireNow(roomId, 'prs', true)).items.every((item) => item.fresh)).toBe(true);
    enqueue.mockRestore();
    await service.fireNow(roomId, 'prs', false);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
  });
  it('consults participants and records their answers under their role', async () => {
    const answer = await service.discuss('lead', { question: 'Is PR 7 safe?' });
    expect(answer).toContain('security says fine');
    expect(answer).toContain('tests says fine');
    const events = await rooms.events(roomId);
    expect(events.filter((event) => event.actor === 'consultant').map((event) => event.role)).toEqual(
      expect.arrayContaining(['security', 'tests']),
    );
  });

  it('reads a model and thinking effort for the lead, the workers and each participant, hands them on and checks them', async () => {
    writeFileSync(
      join(project, '.pi', 'skills', 'pr-review', 'room.yaml'),
      [
        'lead: { model: anthropic/claude-opus-5-5, thinking: high }',
        'workers: { model: local/gemma, thinking: medium }',
        'participants:',
        '  - { role: security, model: nowhere/none }',
        '  - { role: tests, thinking: low }',
        '',
      ].join('\n'),
    );
    const found = (await rooms.get(roomId))!;
    expect(await service.settings(found, 'lead')).toEqual({ model: 'anthropic/claude-opus-5-5', thinking: 'high' });
    expect(await service.settings(found, 'workers')).toEqual({ model: 'local/gemma', thinking: 'medium' });
    await service.consult('lead', { role: 'tests', question: 'Enough tests?' });
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'tests', settings: { thinking: 'low' } }));
    const checks = (await editor.detail(roomId)).checks.filter((check) => check.subject.startsWith('model '));
    expect(checks).toEqual([
      { level: 'ok', subject: 'model lead', message: 'Available.' },
      expect.objectContaining({
        level: 'warn',
        subject: 'model workers',
        message: expect.stringContaining('does not think'),
      }),
      expect.objectContaining({ level: 'error', subject: 'model participant security' }),
    ]);
    writeFileSync(join(project, '.pi', 'skills', 'pr-review', 'room.yaml'), 'lead: { model: no-slash }\n');
    expect(new RoomPlaybookFiles().list({ project })[0]?.error).toContain('lead.model');
  });

  it('asks a participant on a paired computer with a message its pi-kit accepts, and shows what it writes meanwhile', async () => {
    paired = [{ peerId: 'peer-1', name: 'Desktop', state: 'active' }];
    writeFileSync(
      join(project, '.pi', 'skills', 'pr-review', 'room.yaml'),
      'participants:\n  - { role: security, agent: { machine: Desktop }, model: anthropic/claude-opus-5-5, thinking: high }\n',
    );
    const task = (state: string, artifacts: Record<string, unknown>[] = []) =>
      Task.fromJSON({ id: 'c1', contextId: roomId, status: { state }, artifacts });
    a2a.sendMessage.mockResolvedValue(task('TASK_STATE_WORKING'));
    a2a.subscribe.mockImplementation(async function* () {
      for (const [text, append] of [
        ['No secrets', false],
        [' found.', true],
      ] as const)
        yield StreamResponse.fromJSON({
          artifactUpdate: {
            taskId: 'c1',
            contextId: roomId,
            artifact: { artifactId: 'live', parts: [{ text }] },
            append,
            lastChunk: false,
          },
        });
    });
    a2a.getTask.mockResolvedValue(
      task('TASK_STATE_COMPLETED', [
        { artifactId: 'live', parts: [{ text: 'No secrets found.' }] },
        { artifactId: 'answer', parts: [{ text: 'No secrets found in the diff.' }] },
      ]),
    );
    const live: Extract<RoomStreamLine, { type: 'live' }>['live'][] = [];
    bus.subscribe(roomId, (line) => {
      if (line.type === 'live') live.push(line.live);
    });
    expect(await service.consult('lead', { role: 'security', question: 'Any secrets?' })).toBe(
      'No secrets found in the diff.',
    );
    const sent = SendMessageRequest.toJSON(a2a.sendMessage.mock.calls[0]?.[1] as SendMessageRequest) as {
      message: { metadata: Record<string, unknown> };
    };
    expect(A2aRoomConsultSchema.safeParse(sent.message.metadata[A2A_ROOM_EXTENSION]).success).toBe(true);
    expect(
      live.map((piece) => [piece.actor, piece.role, piece.environmentId, piece.text, piece.reset, piece.done]),
    ).toEqual([
      ['consultant', 'security', 'peer-1', '', true, false],
      ['consultant', 'security', 'peer-1', 'No secrets', true, false],
      ['consultant', 'security', 'peer-1', ' found.', false, false],
      ['consultant', 'security', 'peer-1', '', false, true],
    ]);
    expect(a2a.subscribe).toHaveBeenCalledWith('peer-1', { tenant: '', id: 'c1' }, expect.any(AbortSignal));
  }, 10_000);

  it('keeps notes per room and per playbook', async () => {
    await service.note('lead', { key: 'decision', text: 'Ship it.', scope: 'room' });
    await service.note('lead', { key: 'style', text: 'Tabs.', scope: 'playbook' });
    const found = await rooms.get(roomId);
    expect((await service.extras(found!)).memory.map((entry) => [entry.scope, entry.key])).toEqual([
      ['room', 'decision'],
      ['playbook', 'style'],
    ]);
    await service.note('lead', { key: 'decision', text: '', scope: 'room' });
    expect((await service.extras(found!)).memory).toHaveLength(1);
  });

  it('moves to a gated stage only when the owner approves', async () => {
    expect(await service.advance('lead', { stage: 'verdict', summary: 'Reviewed.' })).toContain('owner decides');
    expect((await rooms.get(roomId))?.stage).toBe('review');
    const [action] = await store.actions(roomId);
    await service.decide(roomId, action!.id, { decision: 'approve' });
    expect((await rooms.get(roomId))?.stage).toBe('verdict');
    expect(await service.advance('lead', { stage: 'review', summary: 'Again.' })).toContain('now at review');
  });
  it('shows the playbook with when its triggers run next and what is not ready', async () => {
    const monday = new Date(2026, 10, 23, 7, 30).getTime();
    const detail = await editor.detail(roomId, monday);
    expect(detail).toMatchObject({ name: 'pr-review', folder: join('.pi', 'skills', 'pr-review'), stage: 'review' });
    expect(detail.yaml).toBe(ROOM);
    expect(detail.triggers.find((trigger) => trigger.id === 'brief')?.nextRun).toBe(
      new Date(2026, 10, 23, 8, 0).getTime(),
    );
    expect(detail.checks).toEqual(
      expect.arrayContaining([
        { level: 'ok', subject: 'mcp tracker', message: 'Ready.' },
        expect.objectContaining({
          level: 'error',
          subject: 'mcp mail',
          message: expect.stringContaining('not signed in'),
        }),
        { level: 'ok', subject: 'command node', message: 'Found.' },
      ]),
    );
  });

  it('tries a tool but only shows the call a safe output would make', async () => {
    expect(await editor.try(roomId, { tool: 'show', params: { pr: '7' } })).toMatchObject({
      ran: true,
      ok: true,
      output: 'pr 7',
    });
    expect(await editor.try(roomId, { tool: 'comment', params: { pr: '7' } })).toMatchObject({
      ran: false,
      call: expect.stringContaining('posted'),
      output: '',
    });
    expect(await store.actions(roomId)).toEqual([]);
  });

  it('lists what a dry poll would bring without using it up', async () => {
    const dry = await service.fireNow(roomId, 'prs', true);
    expect(dry.items).toEqual([
      { key: '1/a', fresh: true },
      { key: '2/b', fresh: true },
    ]);
    expect(nudge).not.toHaveBeenCalled();
    await service.fireNow(roomId, 'prs', false);
    expect(await rooms.pendingWakes(roomId)).toBe(1);
    expect((await rooms.nextWake(roomId))?.cause).toMatchObject({ kind: 'owner', trigger: 'prs' });
    expect((await service.fireNow(roomId, 'prs', true)).items.every((item) => !item.fresh)).toBe(true);
  });

  it('lets nothing go out in a rehearsal, not even a safe output that runs at once', async () => {
    await rooms.setRehearsal(roomId, true);
    expect(await service.call('lead', { tool: 'label', params: { pr: '7' }, reason: 'Label it.' })).toContain(
      'Rehearsal: label did not run',
    );
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    const comment = (await store.actions(roomId)).find((action) => action.name === 'comment');
    expect(await service.decide(roomId, comment!.id, { decision: 'approve' })).toMatchObject({
      state: 'done',
      result: 'Rehearsal: it did not run.',
    });
    expect((await rooms.events(roomId)).filter((event) => /^Ran |it ran\./.test(event.text))).toEqual([]);
  });

  it('writes playbook files the lead proposes only once the owner applies them, and not over newer files', async () => {
    const room = join(project, '.pi', 'skills', 'pr-review', 'room.yaml');
    const changed = ROOM.replace('every: 1m', 'every: 5m');
    expect(await editor.propose('lead', { name: 'pr-review', skill: SKILL, yaml: 'tools: [', summary: 'x' })).toContain(
      'Nothing was proposed',
    );
    expect(await store.actions(roomId)).toEqual([]);
    expect(
      await editor.propose('lead', { name: 'pr-review', skill: SKILL, yaml: changed, summary: 'Poll less.' }),
    ).toContain('Proposed as action');
    const [first] = await store.actions(roomId);
    expect(first).toMatchObject({ kind: 'playbook', state: 'pending' });
    expect(first?.payload['files']).toEqual([
      expect.objectContaining({ path: join('.pi', 'skills', 'pr-review', 'room.yaml'), written: false }),
    ]);
    expect(readFileSync(room, 'utf8')).toBe(ROOM);
    expect(await service.decide(roomId, first!.id, { decision: 'approve' })).toMatchObject({ state: 'done' });
    expect(readFileSync(room, 'utf8')).toBe(changed);
    expect(rebriefNext).toHaveBeenCalledWith(roomId);

    await editor.propose('lead', { name: 'pr-review', skill: SKILL, yaml: ROOM, summary: 'Back.' });
    writeFileSync(room, `${changed}# edited by hand\n`);
    const stale = (await store.actions(roomId)).find((action) => action.state === 'pending');
    expect(await service.decide(roomId, stale!.id, { decision: 'approve' })).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('changed since'),
    });
    expect(readFileSync(room, 'utf8')).toContain('edited by hand');
  });

  it('records a run with a step for every tool, consultation, safe output and stage, and settles drafts later', async () => {
    const id = await runs.start(
      roomId,
      { kind: 'poll', trigger: 'prs', title: '2 new: 1, 2\nmore' },
      { playbook: 'pr-review', stage: 'review' },
    );
    await service.call('lead', { tool: 'show', params: { pr: '7' }, reason: 'Read it.' });
    await service.consult('lead', { role: 'security', question: 'Any secrets?' });
    await service.call('lead', { tool: 'comment', params: { pr: '7' }, reason: 'Post it.' });
    await service.call('lead', { tool: 'label', params: { pr: '7' }, reason: 'Label it.' });
    await service.advance('lead', { stage: 'verdict', summary: 'Reviewed.' });
    await runs.end(roomId, id, 'done', 'All reviewed.', 'review');
    const [run] = await runs.list(roomId);
    expect(run).toMatchObject({
      number: 1,
      cause: 'poll',
      trigger: 'prs',
      title: '2 new: 1, 2',
      playbook: 'pr-review',
      state: 'done',
      summary: 'All reviewed.',
    });
    expect(run?.steps.map((step) => [step.kind, step.name, step.state])).toEqual([
      ['tool', 'show', 'done'],
      ['consult', 'security', 'done'],
      ['output', 'comment', 'waiting'],
      ['output', 'label', 'done'],
      ['advance', 'verdict', 'waiting'],
    ]);
    expect(run?.steps[0]).toMatchObject({ output: expect.stringContaining('pr 7') });
    expect(run?.steps[0]?.detail).toContain('process.argv[1]');
    expect(run?.steps[1]).toMatchObject({ detail: 'Any secrets?', output: 'security says fine' });
    const actions = await store.actions(roomId);
    await service.decide(roomId, actions.find((action) => action.name === 'comment')!.id, { decision: 'approve' });
    await service.decide(roomId, actions.find((action) => action.name === 'verdict')!.id, { decision: 'discard' });
    const settled = (await runs.list(roomId))[0];
    expect(settled?.steps.map((step) => [step.name, step.state])).toEqual([
      ['show', 'done'],
      ['security', 'done'],
      ['comment', 'done'],
      ['label', 'done'],
      ['verdict', 'discarded'],
    ]);
    expect(settled?.steps[2]?.output).toBe('posted 7');
    await service.call('lead', { tool: 'show', params: { pr: '8' }, reason: 'No run is open.' });
    expect((await runs.list(roomId))[0]?.steps).toHaveLength(5);
  });

  it('keeps a new playbook in the room’s own folder, out of the repository, and follows it from there', async () => {
    const skill = SKILL.replace('name: pr-review', 'name: triage');
    const folder = join(base, 'data', 'rooms', roomId);
    await editor.propose('lead', { name: 'triage', skill, yaml: 'stages: [sort]\n', summary: 'Sort issues.' });
    const [action] = await store.actions(roomId);
    expect(action?.payload).toMatchObject({ create: true, folder: join('playbooks', 'triage') });
    expect(await service.decide(roomId, action!.id, { decision: 'approve' })).toMatchObject({
      state: 'done',
      result: expect.stringContaining(folder),
    });
    expect(readFileSync(join(folder, 'playbooks', 'triage', 'room.yaml'), 'utf8')).toBe('stages: [sort]\n');
    expect(existsSync(join(project, '.pi', 'skills', 'triage'))).toBe(false);
    expect(git('status', '--porcelain', '--', '.pi/skills/triage')).toBe('');
    const place = { project, room: folder };
    expect(new RoomPlaybookFiles().list(place).map(({ name, origin }) => [name, origin])).toEqual([
      ['triage', 'room'],
      ['pr-review', 'repository'],
    ]);
    expect(new RoomPlaybookFiles().load(place, 'triage').config.stages).toEqual(['sort']);
    await rooms.setPlaybook(roomId, 'triage', 'sort');
    expect(await editor.detail(roomId)).toMatchObject({ origin: 'room', folder: join('playbooks', 'triage') });
  });
});
