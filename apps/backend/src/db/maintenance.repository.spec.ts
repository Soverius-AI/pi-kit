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
const run = (sql: string, ...args: unknown[]) => db.db.prepare(sql).run(...args);
const count = (table: string) => (db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-maintenance-'));
  db = new DatabaseService({ dataDir: dir });
  threads = new ThreadsRepository(db);
  maintenance = new MaintenanceRepository(db);
  threads.insertDraft({ id: 't1', sessionPath: '/s/t1.jsonl', cwd: '/proj' });
});
afterEach(() => {
  maintenance.onModuleDestroy();
  db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('pruning the tables that grow with use', () => {
  it('drops attendant activity older than 90 days and keeps the rest', () => {
    const add = (at: number) =>
      run("INSERT INTO attendant_actions (at, kind, status, text) VALUES (?, 'title', 'done', 'x')", at);
    add(NOW - ACTIONS_KEEP_MS - 1);
    add(NOW - ACTIONS_KEEP_MS + 1);
    expect(maintenance.prune(NOW).actions).toBe(1);
    expect(count('attendant_actions')).toBe(1);
  });

  it("keeps each thread's newest run and every running one", () => {
    const add = (id: string, thread: string, status: string) =>
      run('INSERT INTO runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, 1)', id, thread, status);
    add('a', 't1', 'finished');
    add('b', 't1', 'error');
    add('c', 't1', 'finished');
    add('d', 't2', 'aborted');
    expect(maintenance.prune(NOW).runs).toBe(2);
    expect(
      (db.db.prepare('SELECT run_id FROM runs ORDER BY run_id').all() as { run_id: string }[]).map((r) => r.run_id),
    ).toEqual(['c', 'd']);
  });

  it('keeps runs with snapshots of their folder for 30 days: what the thread changed is read from them', () => {
    const add = (id: string, startedAt: number, tree: string | null) =>
      run(
        "INSERT INTO runs (run_id, thread_id, status, started_at, start_tree) VALUES (?, 't1', 'finished', ?, ?)",
        id,
        startedAt,
        tree,
      );
    add('old-snapshot', NOW - RUN_SNAPSHOTS_KEEP_MS - 1, 'a'.repeat(40));
    add('recent-snapshot', NOW - 1000, 'b'.repeat(40));
    add('no-snapshot', NOW - 1000, null);
    add('newest', NOW, null);
    expect(maintenance.prune(NOW).runs).toBe(2);
    expect(
      (db.db.prepare('SELECT run_id FROM runs ORDER BY run_id').all() as { run_id: string }[]).map((r) => r.run_id),
    ).toEqual(['newest', 'recent-snapshot']);
  });

  it('keeps the snapshots around the work of background agents as long as runs’ snapshots', () => {
    const spans = new AgentSpansRepository(db);
    const add = (agentId: string, startedAt: number) =>
      spans.start({
        agentId,
        threadId: 't1',
        folder: '/proj',
        shadowDir: '/s',
        shadowPrefix: '',
        startTree: 'a'.repeat(40),
        startedAt,
      });
    add('old', NOW - RUN_SNAPSHOTS_KEEP_MS - 1);
    add('recent', NOW - 1000);
    expect(maintenance.prune(NOW).agentSpans).toBe(1);
    expect(spans.ofThread('t1').map((span) => span.agentId)).toEqual(['recent']);
    threads.delete('t1');
    expect(count('agent_spans')).toBe(0);
  });

  it("keeps the open suggestions, every kind but prompts, and each thread's newest settled prompt", () => {
    const add = (kind: string, state: string, thread = 't1') =>
      run(
        'INSERT INTO thread_suggestions (thread_id, kind, target, text, created_at, state) VALUES (?, ?, ?, ?, 1, ?)',
        thread,
        kind,
        'x',
        'y',
        state,
      );
    add('prompt', 'dismissed');
    add('prompt', 'dismissed');
    add('prompt', 'accepted');
    add('label', 'dismissed');
    add('prompt', 'open', 't2');
    expect(maintenance.prune(NOW).suggestions).toBe(2);
    expect(count('thread_suggestions')).toBe(3);
  });

  it('drops terminal screens of unknown folders and of folders nobody opened for 30 days', () => {
    run("INSERT INTO workspaces (cwd, name, last_opened_at) VALUES ('/proj', 'proj', 1), ('/old', 'old', 1)");
    const screen = (cwd: string, at: number) =>
      run('INSERT INTO terminal_replay (cwd, data, updated_at) VALUES (?, ?, ?)', cwd, 'x', at);
    screen('/proj', NOW);
    screen('/old', NOW - TERMINAL_KEEP_MS - 1);
    screen('/gone-worktree', NOW);
    expect(maintenance.prune(NOW).terminals).toBe(2);
    expect((db.db.prepare('SELECT cwd FROM terminal_replay').all() as { cwd: string }[]).map((r) => r.cwd)).toEqual([
      '/proj',
    ]);
  });

  it('drops replay logs whose thread or background agent is gone', () => {
    const event = (owner: string) =>
      run("INSERT INTO thread_events (thread_id, event_json, type) VALUES (?, '{}', 'CUSTOM')", owner);
    run(
      "INSERT INTO bg_agents (id, thread_id, name, role, permission, brief, status, created_at, owner_epoch) VALUES ('7', 't1', 'a', 'r', 'read-only', 'b', 'done', 1, 1)",
    );
    event('t1');
    event('7');
    event('deleted-thread');
    event('deleted-agent');
    expect(maintenance.prune(NOW).events).toBe(2);
    expect(count('thread_events')).toBe(2);
  });
});

describe('deleting a thread', () => {
  it('takes every row the app keeps for it, in one go, and leaves what outlives it on purpose', () => {
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
    for (const [, sql] of tables) run(sql);
    run(
      "INSERT INTO skill_drafts (id, thread_id, name, text, scope, state, created_at) VALUES ('d', 't1', 'n', 't', 'project', 'approved', 1)",
    );
    run("INSERT INTO skill_uses (learned_from, thread_id, at) VALUES ('t1', 't1', 1)");
    threads.delete('t1');
    for (const [table] of tables) expect(count(table), table).toBe(0);
    expect(count('threads')).toBe(0);
    expect(count('skill_drafts')).toBe(1);
    expect(count('skill_uses')).toBe(1);
  });
});
