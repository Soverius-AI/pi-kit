import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentSchema, projectRefKey, threadRefKey } from '@pi-kit/protocol';
import { DatabaseService, DB_FILE, schemaHash } from './database.service';
import { InstanceRepository } from './instance.repository';
import { MetaRepository } from './meta.repository';

const migrationCount = readdirSync(join(import.meta.dirname, 'migrations')).filter((name) =>
  name.endsWith('.sql'),
).length;
const owned: { dir: string; db?: DatabaseService }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.db?.onApplicationShutdown();
    rmSync(item.dir, { recursive: true, force: true });
  }
});
function scratch() {
  const item: { dir: string; db?: DatabaseService } = { dir: mkdtempSync(join(tmpdir(), 'pi-kit-instance-')) };
  owned.push(item);
  return item;
}
function open(item = scratch()) {
  item.db = new DatabaseService({ dataDir: item.dir });
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
  it('upgrades an actual 0001–0003 database without changing projects, preferences or local keys', () => {
    const item = scratch();
    const before = new Database(join(item.dir, DB_FILE));
    const dir = join(import.meta.dirname, 'migrations');
    before.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, sha256 TEXT)');
    for (const name of readdirSync(dir)
      .filter((name) => /^000[123]_.*\.sql$/.test(name))
      .sort()) {
      const sql = readFileSync(join(dir, name), 'utf8');
      before.exec(sql);
      before.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(name, 1, schemaHash(sql));
    }
    before
      .prepare(
        'INSERT INTO workspaces(cwd, name, last_opened_at, sort_order, hidden, collapsed, attendant_off, agents_off, wt_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('/project', 'Existing project', 42, 3, 1, 1, 1, 1, 'worktree');
    before.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?)').run('workspace', JSON.stringify('/project'));
    before
      .prepare(
        'INSERT INTO threads(id, session_path, cwd, project_cwd, worktree_path, pinned, archived, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old-thread', '/sessions/kept.jsonl', '/worktree', '/project', '/worktree', 1, 1, 'Keep my history', 10, 20);
    const thread = before.prepare('SELECT * FROM threads').get();
    const project = before.prepare('SELECT * FROM workspaces').get();
    const settings = before.prepare('SELECT * FROM settings').all();
    before.close();
    const { db, repo } = open(item);
    expect(db.db.prepare('SELECT * FROM workspaces').get()).toEqual(project);
    expect(db.db.prepare('SELECT * FROM settings').all()).toEqual(settings);
    expect(db.db.prepare('SELECT * FROM threads').get()).toEqual(thread);
    expect(EnvironmentSchema.parse(repo.identity())).toEqual(repo.identity());
    expect(new MetaRepository(db).listWorkspaces()[0]).toMatchObject({
      cwd: '/project',
      wtStart: 'worktree',
      hidden: true,
      attendantOff: true,
      agentsOff: true,
    });
    expect(db.db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: migrationCount });
    expect(repo.preferences()).toEqual({ desiredEnabled: false, httpsPort: 8443 });
    const id = repo.identity().instanceId;
    db.onApplicationShutdown();
    const reopened = open(item);
    expect(reopened.repo.identity().instanceId).toBe(id);
    expect(reopened.db.db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: migrationCount });
  });

  it('preserves free names across restart without changing identity or mixing profiles', () => {
    const { item, db, repo } = open();
    const id = repo.identity().instanceId;
    expect(repo.rename('  Arbeits-Mac 日本語  ')).toEqual({
      instanceId: id,
      name: 'Arbeits-Mac 日本語',
      protocolVersion: 1,
    });
    for (const name of ['', ' ', 'x\nname', '\u202eevil', 'x'.repeat(81)]) expect(() => repo.rename(name)).toThrow();
    db.onApplicationShutdown();
    const reopened = open(item);
    expect(reopened.repo.identity()).toEqual({ instanceId: id, name: 'Arbeits-Mac 日本語', protocolVersion: 1 });
    expect(open().repo.identity().instanceId).not.toBe(id);
  });

  it('keeps approvals beyond seven days and persists revocation tombstones', () => {
    const { item, db, repo } = open();
    const device = grant();
    repo.saveDevice(device);
    repo.setPreferences({ desiredEnabled: true, httpsPort: 9443 });
    db.onApplicationShutdown();
    const reopened = open(item);
    expect(reopened.repo.devices()).toEqual([device]);
    expect(reopened.repo.preferences()).toEqual({ desiredEnabled: true, httpsPort: 9443 });
    reopened.repo.revokeDevice(device.id);
    expect(reopened.repo.devices()).toEqual([]);
    expect(() => reopened.repo.saveDevice(device)).toThrow(/reactivated/);
    reopened.db.onApplicationShutdown();
    expect(open(item).repo.devices()).toEqual([]);
  });

  it('does not overwrite a credential identity or partially change invalid preferences', () => {
    const { repo } = open();
    const device = grant();
    repo.saveDevice(device);
    expect(() => repo.saveDevice({ ...device, csrf: 'c'.repeat(43) })).toThrow();
    expect(() => repo.setPreferences({ desiredEnabled: true, httpsPort: 65536 })).toThrow();
    expect(repo.devices()).toEqual([device]);
    expect(repo.preferences()).toEqual({ desiredEnabled: false, httpsPort: 8443 });
  });

  it('rolls back a failed migration transaction without damaging an existing profile', () => {
    const { item, db } = open();
    const meta = new MetaRepository(db);
    meta.touchWorkspace('/keep');
    const migrations = join(item.dir, 'bad-migrations');
    mkdirSync(migrations);
    const source = join(import.meta.dirname, 'migrations');
    for (const name of readdirSync(source).filter((name) => name.endsWith('.sql')))
      writeFileSync(join(migrations, name), readFileSync(join(source, name)));
    writeFileSync(join(migrations, '9999_broken.sql'), 'CREATE TABLE must_rollback(id TEXT); INVALID SQL;');
    const migrate = (db as unknown as { migrate(dir: string): void }).migrate.bind(db);
    expect(() => migrate(migrations)).toThrow();
    expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'").get()).toBeUndefined();
    expect(db.db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: migrationCount });
    expect(meta.listWorkspaces().map((p) => p.cwd)).toEqual(['/keep']);
  });

  it('keeps same project paths and thread IDs distinct across environments', () => {
    const a = open().repo.identity().instanceId;
    const b = open().repo.identity().instanceId;
    expect(projectRefKey({ instanceId: a, cwd: '/same' })).not.toBe(projectRefKey({ instanceId: b, cwd: '/same' }));
    expect(threadRefKey({ instanceId: a, threadId: 'same' })).not.toBe(
      threadRefKey({ instanceId: b, threadId: 'same' }),
    );
  });
});
