import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { BgAgentsRepository } from './bg-agents.repository';

let dir: string;
let database: DatabaseService;
let agents: BgAgentsRepository;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-bg-repo-'));
  database = new DatabaseService({ dataDir: dir });
  agents = new BgAgentsRepository(database);
});
afterEach(() => {
  database.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

const row = (id: string, threadId = 't1') => ({ id, threadId, name: `agent ${id}`, role: 'tester', model: null, permission: 'read-only' as const, brief: 'Do it.', submissionId: null, status: 'active' as const, createdAt: Number(id) });

describe('BgAgentsRepository', () => {
  it('keeps the agents of a thread in order, with their intents and failures as JSON', () => {
    agents.insert(row('2'), 1);
    agents.insert(row('1'), 1);
    agents.insert(row('3', 't2'), 1);
    expect(agents.byThread('t1').map((a) => a.id)).toEqual(['1', '2']);
    expect(agents.get('1')).toMatchObject({ name: 'agent 1', status: 'active', cost: 0, cleanup: null, failures: [], ownerEpoch: 1 });
    expect(agents.update('1', 1, { cleanup: { callId: 'c', command: 'sleep 9', startedAt: 5 }, failures: [1, 2], submissionId: '42' })).toBe(true);
    expect(agents.get('1')).toMatchObject({ cleanup: { callId: 'c', command: 'sleep 9', startedAt: 5 }, failures: [1, 2], submissionId: '42' });
    expect(agents.update('1', 1, { cleanup: null, status: 'done', finishedAt: 9, cost: 0.5, report: 'All good.' })).toBe(true);
    expect(agents.get('1')).toMatchObject({ cleanup: null, status: 'done', finishedAt: 9, cost: 0.5, report: 'All good.' });
    expect(agents.unfinished().map((a) => a.id)).toEqual(['2', '3']);
    agents.remove('2');
    expect(agents.get('2')).toBeUndefined();
  });

  it('drops a write of an older owner once a newer one wrote the row', () => {
    agents.insert(row('1'), 1);
    expect(agents.update('1', 2, { status: 'blocked' })).toBe(true);
    expect(agents.update('1', 1, { status: 'done' })).toBe(false);
    expect(agents.get('1')).toMatchObject({ status: 'blocked', ownerEpoch: 2 });
    expect(agents.update('1', 2, {})).toBe(true);
  });
});
