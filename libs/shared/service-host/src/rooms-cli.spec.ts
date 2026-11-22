import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpcPeer } from './host-channel';
import { type CliContext, runCli } from './service-cli';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const TOKEN = 'b'.repeat(32);
const ROOM = 'a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c';
const ACTION = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TASK = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const room = {
  id: ROOM,
  title: 'Review pull requests',
  repository: 'github.com/acme/pi-kit',
  hostInstanceId: '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01',
  baseCommit: 'a'.repeat(40),
  waiting: 2,
  createdAt: 1,
};
const detail = {
  room,
  summary: '',
  lead: 'idle',
  leadThreadId: 'lead-1',
  projectFolder: '/srv/pi-kit',
  folder: '/data/rooms/a6f1d2c3',
  mode: 'assisted',
  paused: false,
  rehearsal: false,
  playbook: 'pr-review',
  stage: 'review',
  stages: ['collect', 'review', 'verdict'],
  actions: [
    { id: ACTION, kind: 'call', name: 'comment', summary: 'Post the review.', payload: {}, state: 'pending' },
    { id: 'd'.repeat(8), kind: 'call', name: 'label', summary: 'Done already.', payload: {}, state: 'done' },
  ],
  memory: [],
  leadQuestions: [{ id: 'q1', method: 'confirm', title: 'Run gh pr list?' }],
  events: [],
  tasks: [{ id: TASK, title: 'Add b', state: 'proposed', questions: [] }],
};
const playbook = {
  name: 'pr-review',
  origin: 'room',
  error: null,
  triggers: [
    { id: 'prs', kind: 'poll', every: '5m', cron: null, tool: 'open_prs', say: '', lastRun: null, nextRun: null },
  ],
};
const runs = [
  {
    id: 'run-2',
    roomId: ROOM,
    number: 2,
    cause: 'poll',
    trigger: 'prs',
    title: '1 new: 7',
    playbook: 'pr-review',
    stage: 'review',
    state: 'done',
    summary: 'Reviewed #7.',
    startedAt: 1_000,
    endedAt: 66_000,
    steps: [
      {
        seq: 1,
        kind: 'tool',
        name: 'show',
        detail: 'gh pr view 7',
        state: 'done',
        output: 'PR 7: Fix the watcher\n\nopen',
        startedAt: 1_000,
        endedAt: 3_000,
      },
      {
        seq: 2,
        kind: 'output',
        name: 'comment',
        detail: 'gh pr comment 7',
        state: 'waiting',
        output: null,
        startedAt: 3_000,
        endedAt: null,
      },
    ],
  },
];

class RoomsCliHarness {
  static async backend(settings: Record<string, unknown> = { 'collaboration.rooms': true }) {
    const asked: Array<{ method?: string; path?: string; authorization?: string; body: unknown }> = [];
    const server = createServer(async (req: IncomingMessage, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const path = req.url ?? '';
      asked.push({
        method: req.method,
        path,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const json = (body: unknown, status = 200) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (path === '/api/settings') return json(settings);
      if (path.startsWith('/api/settings/')) return json({ key: 'collaboration.rooms', value: true });
      if (path === '/api/rooms' && req.method === 'GET') return json([room]);
      if (path === '/api/rooms') return json(room, 201);
      if (path.endsWith('/events?after=0'))
        return res.writeHead(200, { 'content-type': 'application/x-ndjson' }).end(
          [
            { type: 'lead', state: 'working' },
            { type: 'event', event: { actor: 'owner', text: 'Go.' } },
            { type: 'event', event: { actor: 'consultant', role: 'security', text: 'Fine.' } },
            { type: 'run', run: runs[0] },
            {
              type: 'live',
              live: { id: 'l1', actor: 'lead', role: null, text: '', reset: false, activity: 'room_call' },
            },
            {
              type: 'live',
              live: { id: 'l1', actor: 'lead', role: null, text: 'Two wait', reset: true, activity: null },
            },
            {
              type: 'live',
              live: { id: 'l1', actor: 'lead', role: null, text: ' on you.', reset: false, activity: null },
            },
            { type: 'live', live: { id: 'l1', actor: 'lead', role: null, text: '', reset: false, done: true } },
            { type: 'event', event: { actor: 'lead', kind: 'message', text: 'Two wait on you.' } },
            { type: 'event', event: { actor: 'lead', kind: 'message', text: 'And one more thing.' } },
            { type: 'lead', state: 'idle' },
          ]
            .map((line) => JSON.stringify(line))
            .join('\n\n') + '\n',
        );
      if (path.endsWith('/runs')) return json(runs);
      if (path.endsWith('/playbook')) return json(playbook);
      if (path.includes('/playbook/triggers/'))
        return json({
          text: '1 new among 2.',
          items: [
            { key: '7', fresh: true },
            { key: '6', fresh: false },
          ],
        });
      if (path.includes('/actions/')) return json({ ...detail.actions[0], state: 'done', result: 'posted 7' });
      if (path.endsWith('/archive')) return res.writeHead(204).end();
      if (path.endsWith('/messages')) return json({ seq: 1 }, 201);
      if (path.includes('/tasks/')) return json(detail.tasks[0]);
      return json(detail);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanup.push(() => new Promise((done) => server.close(done)));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const host = { call: async () => ({ url, port: 0, token: TOKEN }), close: () => undefined } as unknown as RpcPeer;
    return { asked, host };
  }

  static context(host: RpcPeer | undefined): CliContext {
    return {
      version: '0.0.0',
      serviceName: 'test',
      dataDir: tmpdir(),
      logDir: tmpdir(),
      manager: undefined,
      discover: () =>
        host ? { pid: 1, version: '0.0.0', level: 'login', socket: 's', token: 't', startedAt: 'now' } : undefined,
      connect: async () => host as RpcPeer,
      tail: () => undefined,
      sleep: async () => undefined,
    };
  }

  static async cli(host: RpcPeer | undefined, ...args: string[]) {
    let out = '';
    let err = '';
    const code = await runCli(
      ['rooms', ...args],
      { out: (text) => (out += text), err: (text) => (err += text) },
      RoomsCliHarness.context(host),
    );
    return { code, out, err };
  }
}

describe('pi-kit rooms', () => {
  it('says rooms are off, turns them on, and lists the rooms with what waits', async () => {
    const off = await RoomsCliHarness.backend({});
    expect((await RoomsCliHarness.cli(off.host)).out).toContain('Rooms are off here');
    expect((await RoomsCliHarness.cli(off.host, '--json')).out).toBe('{"enabled":false,"rooms":[]}\n');
    expect((await RoomsCliHarness.cli(off.host, 'on')).out).toContain('Rooms are on');
    expect(off.asked.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/settings/collaboration.rooms',
      authorization: `Bearer ${TOKEN}`,
      body: { value: true },
    });
    const on = await RoomsCliHarness.backend();
    expect((await RoomsCliHarness.cli(on.host)).out).toBe(
      'a6f1d2c3  Review pull requests  (github.com/acme/pi-kit)  2 waiting for you\n',
    );
  });

  it('starts a room from a folder with a playbook, and needs a title', async () => {
    const { asked, host } = await RoomsCliHarness.backend();
    expect((await RoomsCliHarness.cli(host, 'start', 'repo')).code).toBe(2);
    const started = await RoomsCliHarness.cli(
      host,
      'start',
      'repo',
      '--title',
      'Review pull requests',
      '--playbook',
      'pr-review',
    );
    expect(started).toMatchObject({ code: 0, out: expect.stringContaining('pi-kit rooms say a6f1d2c3') });
    expect(asked.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/rooms',
      body: { projectFolder: resolve('repo'), title: 'Review pull requests', summary: '', playbook: 'pr-review' },
    });
  });

  it('shows a room found by the start of its id or its title: playbook, triggers, what waits and the last runs', async () => {
    const { host } = await RoomsCliHarness.backend();
    const shown = await RoomsCliHarness.cli(host, 'show', 'review pull requests');
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('Assisted, active; the lead is idle');
    expect(shown.out).toContain('Room folder: /data/rooms/a6f1d2c3');
    expect(shown.out).toContain('Playbook: pr-review (in the room’s folder); stages collect > [review] > verdict');
    expect(shown.out).toContain('Trigger prs: every 5m, open_prs');
    expect(shown.out).toContain('draft b1b2c3d4  comment: Post the review.');
    expect(shown.out).toContain('task c1d2e3f4  Add b (proposed)');
    expect(shown.out).toContain('question q1  the lead asks: Run gh pr list? (yes or no)');
    expect(shown.out).not.toContain('Done already.');
    expect(shown.out).toContain('#2  done     1m 5s    new items prs: 1 new: 7');
    const json = JSON.parse((await RoomsCliHarness.cli(host, 'show', 'a6f1', '--json')).out) as {
      waiting: unknown[];
      runs: unknown[];
    };
    expect(json.waiting).toHaveLength(3);
    expect(json.runs).toHaveLength(1);
    expect(await RoomsCliHarness.cli(host, 'show', 'nope')).toMatchObject({
      code: 1,
      err: expect.stringContaining('no room "nope"'),
    });
  });

  it('prints a run with every step, its call and its output', async () => {
    const { host } = await RoomsCliHarness.backend();
    expect((await RoomsCliHarness.cli(host, 'runs', 'a6f1')).out).toBe(
      '#2  done     1m 5s    new items prs: 1 new: 7\n',
    );
    const one = (await RoomsCliHarness.cli(host, 'runs', 'a6f1', '#2')).out;
    expect(one).toContain('  done      tool show  2s\n      $ gh pr view 7\n      PR 7: Fix the watcher\n      open\n');
    expect(one).toContain('  waiting   output comment\n      $ gh pr comment 7\n');
    expect(one).toContain('\nReviewed #7.\n');
    expect(await RoomsCliHarness.cli(host, 'runs', 'a6f1', '9')).toMatchObject({ code: 1 });
  });

  it('messages the lead, approves, answers, fires a trigger and archives', async () => {
    const { asked, host } = await RoomsCliHarness.backend();
    await RoomsCliHarness.cli(host, 'say', 'a6f1', 'Review', '#7', 'now');
    expect(asked.at(-1)).toMatchObject({
      path: `/api/rooms/${ROOM}/messages`,
      body: { text: 'Review #7 now', route: 'lead' },
    });
    await RoomsCliHarness.cli(host, 'say', 'a6f1', 'Note', '--post');
    expect(asked.at(-1)?.body).toEqual({ text: 'Note', route: 'none' });

    expect((await RoomsCliHarness.cli(host, 'approve', 'a6f1', 'b1b2')).out).toBe('comment: done\nposted 7\n');
    expect(asked.at(-1)).toMatchObject({ path: `/api/rooms/${ROOM}/actions/${ACTION}`, body: { decision: 'approve' } });
    expect((await RoomsCliHarness.cli(host, 'discard', 'a6f1', 'c1d2')).out).toContain('Declined "Add b"');
    expect(asked.at(-1)?.path).toBe(`/api/rooms/${ROOM}/tasks/${TASK}/decline`);
    expect(await RoomsCliHarness.cli(host, 'approve', 'a6f1', 'dddd')).toMatchObject({ code: 1 });

    await RoomsCliHarness.cli(host, 'answer', 'a6f1', 'q1', 'yes');
    expect(asked.at(-1)).toMatchObject({
      path: `/api/rooms/${ROOM}/lead/answer`,
      body: { answers: [{ id: 'q1', confirmed: true }] },
    });

    expect((await RoomsCliHarness.cli(host, 'fire', 'a6f1', 'prs', '--dry')).out).toBe(
      '1 new among 2.\n  new   7\n  seen  6\n',
    );
    expect(asked.at(-1)).toMatchObject({ path: `/api/rooms/${ROOM}/playbook/triggers/prs`, body: { dry: true } });

    await RoomsCliHarness.cli(host, 'pause', 'a6f1');
    expect(asked.at(-1)).toMatchObject({ method: 'PATCH', body: { paused: true } });
    await RoomsCliHarness.cli(host, 'playbook', 'a6f1', 'none');
    expect(asked.at(-1)?.body).toEqual({ playbook: null });
    await RoomsCliHarness.cli(host, 'archive', 'a6f1', '--stop');
    expect(asked.at(-1)).toMatchObject({ path: `/api/rooms/${ROOM}/archive`, body: { stopTasks: true } });
  });

  it('follows a room: who said what, what is being written, the lead’s state and each run', async () => {
    const { host } = await RoomsCliHarness.backend();
    expect((await RoomsCliHarness.cli(host, 'watch', 'a6f1')).out).toBe(
      [
        '    the lead is working',
        '[owner] Go.',
        '[security] Fine.',
        '    run #2  done     1m 5s    new items prs: 1 new: 7',
        '    lead uses room_call',
        '[lead] Two wait on you.',
        '[lead] And one more thing.',
        '    the lead is idle',
        '',
      ].join('\n'),
    );
  });

  it('explains itself on a command it does not know, and needs the service', async () => {
    const { host } = await RoomsCliHarness.backend();
    expect(await RoomsCliHarness.cli(host, 'destroy', 'a6f1')).toMatchObject({
      code: 2,
      err: expect.stringContaining('unknown command "rooms destroy"'),
    });
    expect(await RoomsCliHarness.cli(host, 'show')).toMatchObject({ code: 2 });
    expect(await RoomsCliHarness.cli(host, 'start', 'repo', '--title')).toMatchObject({
      code: 2,
      err: expect.stringContaining('--title needs a value'),
    });
    expect(await RoomsCliHarness.cli(undefined, 'on')).toMatchObject({
      code: 1,
      err: expect.stringContaining('the service is not running here'),
    });
  });
});
