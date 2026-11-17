import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSpansRepository } from './agent-spans.repository';
import { DatabaseService } from './database.service';
import {
  ACTIONS_KEEP_MS,
  MaintenanceRepository,
  RUN_SNAPSHOTS_KEEP_MS,
  TERMINAL_KEEP_MS,
} from './maintenance.repository';
import { ThreadsRepository } from './threads.repository';

let dir: string;
let db: DatabaseService;
let threads: ThreadsRepository;
let maintenance: MaintenanceRepository;
const NOW = 1_800_000_000_000;
const run = async (sql: string, ...args: unknown[]) => await db.db.prepare(sql).run(...args);
const count = async (table: string) =>
  ((await db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number }).n;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-maintenance-'));
  db = await DatabaseService.create({ dataDir: dir });
  threads = new ThreadsRepository(db);
  maintenance = new MaintenanceRepository(db);
  await threads.insertDraft({ id: 't1', sessionPath: '/s/t1.jsonl', cwd: '/proj' });
});
afterEach(async () => {
  await maintenance.onModuleDestroy();
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('pruning the tables that grow with use', () => {
  it('drops attendant activity older than 90 days and keeps the rest', async () => {
    const add = async (at: number) =>
      await run("INSERT INTO attendant_actions (at, kind, status, text) VALUES (?, 'title', 'done', 'x')", at);
    await add(NOW - ACTIONS_KEEP_MS - 1);
    await add(NOW - ACTIONS_KEEP_MS + 1);
    expect((await maintenance.prune(NOW)).actions).toBe(1);
    expect(await count('attendant_actions')).toBe(1);
  });

  it("keeps each thread's newest run and every running one", async () => {
    const add = async (id: string, thread: string, status: string) =>
      await run('INSERT INTO runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, 1)', id, thread, status);
    await add('a', 't1', 'finished');
    await add('b', 't1', 'error');
    await add('c', 't1', 'finished');
    await add('d', 't2', 'aborted');
    expect((await maintenance.prune(NOW)).runs).toBe(2);
    expect(
      ((await db.db.prepare('SELECT run_id FROM runs ORDER BY run_id').all()) as { run_id: string }[]).map(
        (r) => r.run_id,
      ),
    ).toEqual(['c', 'd']);
  });

  it('keeps runs with snapshots of their folder for 30 days: what the thread changed is read from them', async () => {
    const add = async (id: string, startedAt: number, tree: string | null) =>
      await run(
        "INSERT INTO runs (run_id, thread_id, status, started_at, start_tree) VALUES (?, 't1', 'finished', ?, ?)",
        id,
        startedAt,
        tree,
      );
    await add('old-snapshot', NOW - RUN_SNAPSHOTS_KEEP_MS - 1, 'a'.repeat(40));
    await add('recent-snapshot', NOW - 1000, 'b'.repeat(40));
    await add('no-snapshot', NOW - 1000, null);
    await add('newest', NOW, null);
    expect((await maintenance.prune(NOW)).runs).toBe(2);
    expect(
      ((await db.db.prepare('SELECT run_id FROM runs ORDER BY run_id').all()) as { run_id: string }[]).map(
        (r) => r.run_id,
      ),
    ).toEqual(['newest', 'recent-snapshot']);
  });

  it('keeps the snapshots around the work of background agents as long as runs’ snapshots', async () => {
    const spans = new AgentSpansRepository(db);
    const add = async (agentId: string, startedAt: number) =>
      await spans.start({
        agentId,
        threadId: 't1',
        folder: '/proj',
        shadowDir: '/s',
        shadowPrefix: '',
        startTree: 'a'.repeat(40),
        startedAt,
      });
    await add('old', NOW - RUN_SNAPSHOTS_KEEP_MS - 1);
    await add('recent', NOW - 1000);
    expect((await maintenance.prune(NOW)).agentSpans).toBe(1);
    expect((await spans.ofThread('t1')).map((span) => span.agentId)).toEqual(['recent']);
    await threads.delete('t1');
    expect(await count('agent_spans')).toBe(0);
  });

  it("keeps the open suggestions, every kind but prompts, and each thread's newest settled prompt", async () => {
    const add = async (kind: string, state: string, thread = 't1') =>
      await run(
        'INSERT INTO thread_suggestions (thread_id, kind, target, text, created_at, state) VALUES (?, ?, ?, ?, 1, ?)',
        thread,
        kind,
        'x',
        'y',
        state,
      );
    await add('prompt', 'dismissed');
    await add('prompt', 'dismissed');
    await add('prompt', 'accepted');
    await add('label', 'dismissed');
    await add('prompt', 'open', 't2');
    expect((await maintenance.prune(NOW)).suggestions).toBe(2);
    expect(await count('thread_suggestions')).toBe(3);
  });

  it('drops terminal screens of unknown folders and of folders nobody opened for 30 days', async () => {
    await run("INSERT INTO workspaces (cwd, name, last_opened_at) VALUES ('/proj', 'proj', 1), ('/old', 'old', 1)");
    const screen = async (cwd: string, at: number) =>
      await run('INSERT INTO terminal_replay (cwd, data, updated_at) VALUES (?, ?, ?)', cwd, 'x', at);
    await screen('/proj', NOW);
    await screen('/old', NOW - TERMINAL_KEEP_MS - 1);
    await screen('/gone-worktree', NOW);
    expect((await maintenance.prune(NOW)).terminals).toBe(2);
    expect(
      ((await db.db.prepare('SELECT cwd FROM terminal_replay').all()) as { cwd: string }[]).map((r) => r.cwd),
    ).toEqual(['/proj']);
  });

  it('drops replay logs whose thread or background agent is gone', async () => {
    const event = async (owner: string) =>
      await run("INSERT INTO thread_events (thread_id, event_json, type) VALUES (?, '{}', 'CUSTOM')", owner);
    await run(
      "INSERT INTO bg_agents (id, thread_id, name, role, permission, brief, status, created_at, owner_epoch) VALUES ('7', 't1', 'a', 'r', 'read-only', 'b', 'done', 1, 1)",
    );
    await event('t1');
    await event('7');
    await event('deleted-thread');
    await event('deleted-agent');
    expect((await maintenance.prune(NOW)).events).toBe(2);
    expect(await count('thread_events')).toBe(2);
  });
});

describe('deleting a thread', () => {
  it('takes every row the app keeps for it, in one go, and leaves what outlives it on purpose', async () => {
    const tables: [string, string][] = [
      ['thread_events', "INSERT INTO thread_events (thread_id, event_json, type) VALUES ('t1', '{}', 'CUSTOM')"],
      ['runs', "INSERT INTO runs (run_id, thread_id, status, started_at) VALUES ('r', 't1', 'finished', 1)"],
      [
        'review_comments',
        "INSERT INTO review_comments (thread_id, id, position, file, side, line, snippet, text) VALUES ('t1', 'c', 0, 'a', 'new', 1, 's', 't')",
      ],
      [
        'feedback',
        "INSERT INTO feedback (thread_id, message_id, rating, created_at, updated_at) VALUES ('t1', 'm', 'up', 1, 1)",
      ],
      ['thread_meta', "INSERT INTO thread_meta (thread_id, summary) VALUES ('t1', 's')"],
      [
        'thread_suggestions',
        "INSERT INTO thread_suggestions (thread_id, kind, target, text, created_at) VALUES ('t1', 'label', 'x', 'y', 1)",
      ],
      ['file_leases', "INSERT INTO file_leases (thread_id, cwd, path, since, at) VALUES ('t1', '/proj', 'a', 1, 1)"],
      [
        'thread_dialog_answers',
        "INSERT INTO thread_dialog_answers (thread_id, at, method, title, status) VALUES ('t1', 1, 'confirm', 'q', 'answered')",
      ],
    ];
    for (const [, sql] of tables) await run(sql);
    await run(
      "INSERT INTO skill_drafts (id, thread_id, name, text, scope, state, created_at) VALUES ('d', 't1', 'n', 't', 'project', 'approved', 1)",
    );
    await run("INSERT INTO skill_uses (learned_from, thread_id, at) VALUES ('t1', 't1', 1)");
    await threads.delete('t1');
    for (const [table] of tables) expect(await count(table), table).toBe(0);
    expect(await count('threads')).toBe(0);
    expect(await count('skill_drafts')).toBe(1);
    expect(await count('skill_uses')).toBe(1);
  });
});
