import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { BgAgentsRepository } from './bg-agents.repository';

let dir: string;
let database: DatabaseService;
let agents: BgAgentsRepository;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-bg-repo-'));
  database = await DatabaseService.create({ dataDir: dir });
  agents = new BgAgentsRepository(database);
});
afterEach(async () => {
  await database.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

const row = (id: string, threadId = 't1') => ({
  id,
  threadId,
  name: `agent ${id}`,
  role: 'tester',
  model: null,
  permission: 'read-only' as const,
  brief: 'Do it.',
  submissionId: null,
  status: 'active' as const,
  createdAt: Number(id),
});

describe('BgAgentsRepository', () => {
  it('keeps the agents of a thread in order, with their intents and failures as JSON', async () => {
    await agents.insert(row('2'), 1);
    await agents.insert(row('1'), 1);
    await agents.insert(row('3', 't2'), 1);
    expect((await agents.byThread('t1')).map((a) => a.id)).toEqual(['1', '2']);
    expect(await agents.get('1')).toMatchObject({
      name: 'agent 1',
      status: 'active',
      cost: 0,
      cleanup: null,
      failures: [],
      ownerEpoch: 1,
    });
    expect(
      await agents.update('1', 1, {
        cleanup: { callId: 'c', command: 'sleep 9', startedAt: 5 },
        failures: [1, 2],
        submissionId: '42',
      }),
    ).toBe(true);
    expect(await agents.get('1')).toMatchObject({
      cleanup: { callId: 'c', command: 'sleep 9', startedAt: 5 },
      failures: [1, 2],
      submissionId: '42',
    });
    expect(
      await agents.update('1', 1, { cleanup: null, status: 'done', finishedAt: 9, cost: 0.5, report: 'All good.' }),
    ).toBe(true);
    expect(await agents.get('1')).toMatchObject({
      cleanup: null,
      status: 'done',
      finishedAt: 9,
      cost: 0.5,
      report: 'All good.',
    });
    expect((await agents.unfinished()).map((a) => a.id)).toEqual(['2', '3']);
    await agents.remove('2');
    expect(await agents.get('2')).toBeUndefined();
  });

  it('drops a write of an older owner once a newer one wrote the row', async () => {
    await agents.insert(row('1'), 1);
    expect(await agents.update('1', 2, { status: 'blocked' })).toBe(true);
    expect(await agents.update('1', 1, { status: 'done' })).toBe(false);
    expect(await agents.get('1')).toMatchObject({ status: 'blocked', ownerEpoch: 2 });
    expect(await agents.update('1', 2, {})).toBe(true);
  });
});
