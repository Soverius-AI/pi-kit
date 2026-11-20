import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncSqlite } from './async-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEnvironmentLook, EnvironmentSchema, projectRefKey, threadRefKey } from '@pi-kit/protocol';
import { DatabaseService, DB_FILE, schemaHash } from './database.service';
import { InstanceRepository } from './instance.repository';
import { MetaRepository } from './meta.repository';

const migrationCount = readdirSync(join(import.meta.dirname, 'migrations')).filter((name) =>
  name.endsWith('.sql'),
).length;
const owned: { dir: string; db?: DatabaseService }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.db?.onApplicationShutdown();
    rmSync(item.dir, { recursive: true, force: true });
  }
});
function scratch() {
  const item: { dir: string; db?: DatabaseService } = { dir: mkdtempSync(join(tmpdir(), 'pi-kit-instance-')) };
  owned.push(item);
  return item;
}
async function open(item = scratch()) {
  item.db = await DatabaseService.create({ dataDir: item.dir });
  return { item, db: item.db, repo: new InstanceRepository(item.db) };
}
const grant = () => ({
  id: randomUUID(),
  name: 'Phone',
  cookieHash: 'a'.repeat(64),
  csrf: 'b'.repeat(43),
  createdAt: 100,
  lastSeenAt: 100,
});

describe('instance identity and additive migration', () => {
  it('upgrades an actual 0001–0003 database without changing projects, preferences or local keys', async () => {
    const item = scratch();
    const before = await AsyncSqlite.open(join(item.dir, DB_FILE));
    const dir = join(import.meta.dirname, 'migrations');
    await before.exec(
      'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, sha256 TEXT)',
    );
    for (const name of readdirSync(dir)
      .filter((name) => /^000[123]_.*\.sql$/.test(name))
      .sort()) {
      const sql = readFileSync(join(dir, name), 'utf8');
      await before.exec(sql);
      await before.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(name, 1, schemaHash(sql));
    }
    await before
      .prepare(
        'INSERT INTO workspaces(cwd, name, last_opened_at, sort_order, hidden, collapsed, attendant_off, agents_off, wt_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('/project', 'Existing project', 42, 3, 1, 1, 1, 1, 'worktree');
    await before
      .prepare('INSERT INTO settings(key, value_json) VALUES (?, ?)')
      .run('workspace', JSON.stringify('/project'));
    await before
      .prepare(
        'INSERT INTO threads(id, session_path, cwd, project_cwd, worktree_path, pinned, archived, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old-thread', '/sessions/kept.jsonl', '/worktree', '/project', '/worktree', 1, 1, 'Keep my history', 10, 20);
    const thread = await before.prepare('SELECT * FROM threads').get();
    const project = await before.prepare('SELECT * FROM workspaces').get();
    const settings = await before.prepare('SELECT * FROM settings').all();
    await before.close();
    const { db, repo } = await open(item);
    expect(await db.db.prepare('SELECT * FROM workspaces').get()).toEqual(project);
    expect(await db.db.prepare('SELECT * FROM settings').all()).toEqual(settings);
    expect(await db.db.prepare('SELECT * FROM threads').get()).toEqual(thread);
    expect(EnvironmentSchema.parse(await repo.identity())).toEqual(await repo.identity());
    expect((await new MetaRepository(db).listWorkspaces())[0]).toMatchObject({
      cwd: '/project',
      wtStart: 'worktree',
      hidden: true,
      attendantOff: true,
      agentsOff: true,
    });
    expect(await db.db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: migrationCount });
    expect(await repo.preferences()).toEqual({ desiredEnabled: false, httpsPort: 8443 });
    const id = (await repo.identity()).instanceId;
    await db.onApplicationShutdown();
    const reopened = await open(item);
    expect((await reopened.repo.identity()).instanceId).toBe(id);
    expect(await reopened.db.db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({
      n: migrationCount,
    });
  });

  it('preserves free names across restart without changing identity or mixing profiles', async () => {
    const { item, db, repo } = await open();
    const id = (await repo.identity()).instanceId;
    expect(await repo.rename('  Arbeits-Mac 日本語  ')).toEqual({
      instanceId: id,
      name: 'Arbeits-Mac 日本語',
      protocolVersion: 1,
    });
    for (const name of ['', ' ', 'x\nname', '\u202eevil', 'x'.repeat(81)])
      await expect(repo.rename(name)).rejects.toThrow();
    await db.onApplicationShutdown();
    const reopened = await open(item);
    expect(await reopened.repo.identity()).toEqual({ instanceId: id, name: 'Arbeits-Mac 日本語', protocolVersion: 1 });
    expect((await (await open()).repo.identity()).instanceId).not.toBe(id);
  });

  it('keeps approvals beyond seven days and persists revocation tombstones', async () => {
    const { item, db, repo } = await open();
    const device = grant();
    await repo.saveDevice(device);
    await repo.setPreferences({ desiredEnabled: true, httpsPort: 9443 });
    await db.onApplicationShutdown();
    const reopened = await open(item);
    expect(await reopened.repo.devices()).toEqual([device]);
    expect(await reopened.repo.preferences()).toEqual({ desiredEnabled: true, httpsPort: 9443 });
    await reopened.repo.revokeDevice(device.id);
    expect(await reopened.repo.devices()).toEqual([]);
    await expect(reopened.repo.saveDevice(device)).rejects.toThrow(/reactivated/);
    await reopened.db.onApplicationShutdown();
    expect(await (await open(item)).repo.devices()).toEqual([]);
  });

  it('does not overwrite a credential identity or partially change invalid preferences', async () => {
    const { repo } = await open();
    const device = grant();
    await repo.saveDevice(device);
    await expect(repo.saveDevice({ ...device, csrf: 'c'.repeat(43) })).rejects.toThrow();
    await expect(repo.setPreferences({ desiredEnabled: true, httpsPort: 65536 })).rejects.toThrow();
    expect(await repo.devices()).toEqual([device]);
    expect(await repo.preferences()).toEqual({ desiredEnabled: false, httpsPort: 8443 });
  });

  it('rolls back a failed migration transaction without damaging an existing profile', async () => {
    const { item, db } = await open();
    const meta = new MetaRepository(db);
    await meta.touchWorkspace('/keep');
    const migrations = join(item.dir, 'bad-migrations');
    mkdirSync(migrations);
    const source = join(import.meta.dirname, 'migrations');
    for (const name of readdirSync(source).filter((name) => name.endsWith('.sql')))
      writeFileSync(join(migrations, name), readFileSync(join(source, name)));
    writeFileSync(join(migrations, '9999_broken.sql'), 'CREATE TABLE must_rollback(id TEXT); INVALID SQL;');
    const migrate = (db as unknown as { migrate(dir: string): Promise<void> }).migrate.bind(db);
    await expect(migrate(migrations)).rejects.toThrow();
    expect(await db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'").get()).toBeUndefined();
    expect(await db.db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: migrationCount });
    expect((await meta.listWorkspaces()).map((p) => p.cwd)).toEqual(['/keep']);
  });

  it('keeps same project paths and thread IDs distinct across environments', async () => {
    const a = (await (await open()).repo.identity()).instanceId;
    const b = (await (await open()).repo.identity()).instanceId;
    expect(projectRefKey({ instanceId: a, cwd: '/same' })).not.toBe(projectRefKey({ instanceId: b, cwd: '/same' }));
    expect(threadRefKey({ instanceId: a, threadId: 'same' })).not.toBe(
      threadRefKey({ instanceId: b, threadId: 'same' }),
    );
  });
});

describe('environment look', () => {
  it('derives a look from the instance id until the owner chooses one, and keeps the choice across restarts', async () => {
    const { item, db, repo } = await open();
    expect(await repo.look()).toEqual(defaultEnvironmentLook(repo.instanceId));
    expect(await repo.setLook({ icon: 'oni', color: 7 })).toEqual({ icon: 'oni', color: 7 });
    await db.onApplicationShutdown();
    const reopened = await open(item);
    expect(await reopened.repo.look()).toEqual({ icon: 'oni', color: 7 });
    expect(
      EnvironmentSchema.parse({ ...(await reopened.repo.identity()), look: await reopened.repo.look() }).look,
    ).toEqual({ icon: 'oni', color: 7 });
  });

  it('refuses a look outside the nine icons and colours', async () => {
    const { repo } = await open();
    await expect(repo.setLook({ icon: 'dragon' as never, color: 3 })).rejects.toThrow();
    await expect(repo.setLook({ icon: 'neko', color: 10 })).rejects.toThrow();
  });
});
