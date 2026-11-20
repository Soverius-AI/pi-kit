import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { PiSessionService } from '../pi/pi-session.service';
import { RoomPlaybookTools } from './room-playbook-tools.service';
import type { RoomConsultant } from './room-consultant.service';
import type { RoomLeadService } from './room-lead.service';
import { McpCallService } from '../mcp/mcp-call.service';
import { RoomSources } from './room-sources.service';
import { RoomPlaybookService } from './room-playbook.service';
import { RoomPlaybookFiles } from './room-playbook-files.service';
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
let ask: ReturnType<typeof vi.fn>;
let roomId: string;
let agentDir: string;

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
  const files = new RoomPlaybookFiles();
  const tools = new RoomPlaybookTools(mcp, new RoomSources());
  const bus = new RoomBus(rooms);
  const lead = { nudge, rebriefNext, setPlaybooks: () => undefined } as unknown as RoomLeadService;
  const agents = { projectFolder: async () => project } as unknown as RoomAgents;
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
    {} as RoomA2aClient,
    { list: async () => [] } as unknown as RoomA2aAgents,
    { manager: async () => ({ self: { name: 'Here' }, peers: [] }) } as unknown as PeersService,
    editor,
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
    expect(new RoomPlaybookFiles().list(project)).toEqual([
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
    expect(new RoomPlaybookFiles().list(project)[0]?.error).toContain('safe outputs never run from a trigger');
    writeFileSync(room, 'on:\n  schedule:\n    - { id: t, cron: "99 * * * *" }\n');
    expect(new RoomPlaybookFiles().list(project)[0]?.error).toContain('cron');
    writeFileSync(room, 'connectors: {}\n');
    expect(new RoomPlaybookFiles().list(project)[0]?.error).toContain('connectors');
    rmSync(room);
    expect(new RoomPlaybookFiles().list(project)).toEqual([]);
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
    expect(nudge).toHaveBeenCalledWith(roomId, expect.stringContaining('posted 7'));
    await expect(service.decide(roomId, action!.id, { decision: 'discard' })).rejects.toThrow('decided already');
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
    expect(nudge.mock.calls.filter((call) => String(call[1]).startsWith('Schedule brief'))).toHaveLength(1);
    expect((await store.lastRuns(roomId)).get('brief')).toBe(Math.floor(monday / 60_000) * 60_000);
    await service.tick(new Date(2026, 10, 22, 8, 0, 10).getTime());
    expect(nudge.mock.calls.filter((call) => String(call[1]).startsWith('Schedule brief'))).toHaveLength(1);
  });

  it('keeps connector values from becoming options', async () => {
    await expect(service.call('lead', { tool: 'show', params: { pr: '--help' }, reason: 'x' })).rejects.toThrow('dash');
  });

  it('wakes the lead only for items it has not seen, by their key', async () => {
    const sunday = new Date(2026, 10, 22, 12, 0).getTime();
    await service.tick(sunday);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge.mock.calls[0]?.[1]).toContain('found 2 new items');
    await service.tick(sunday + 120_000);
    expect(nudge).toHaveBeenCalledTimes(1);
    await rooms.setPaused(roomId, true);
    await service.tick(sunday + 240_000);
    expect(nudge).toHaveBeenCalledTimes(1);
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
    expect(nudge.mock.calls[0]?.[1]).toContain('found 2 new items');
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
});
