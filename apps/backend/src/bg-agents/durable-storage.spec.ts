import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as encryption from '../db/encryption';
import { LOCK_FILE, openDurableStore, StoreOwnedError, takeOwnerLock } from './durable-storage';

const key = 'ab'.repeat(32);
let dir: string;
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('openDurableStore', () => {
  it('runs SQL through the facade, rolls a failed transaction back, and the file is encrypted at rest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-store-'));
    const path = join(dir, 'bg-agents.sqlite');
    const store = openDurableStore(path, key);
    await store.exec('CREATE TABLE notes (text TEXT)');
    await store.run('INSERT INTO notes (text) VALUES (?)', 'one');
    await store.transaction(async (tx) => {
      await tx.run('INSERT INTO notes (text) VALUES (?)', 'two');
    });
    await expect(
      store.transaction(async (tx) => {
        await tx.run('INSERT INTO notes (text) VALUES (?)', 'three');
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await store.all<{ text: string }>('SELECT text FROM notes ORDER BY rowid')).toEqual([{ text: 'one' }, { text: 'two' }]);
    expect(await store.get<{ n: number }>('SELECT count(*) AS n FROM notes')).toEqual({ n: 2 });
    await store.close();
    await expect(store.run('SELECT 1')).rejects.toThrow('closing');
    expect(readFileSync(path).subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0');
    expect(() => openDurableStore(path, 'cd'.repeat(32))).toThrow();
  });
});

describe('durable store protection follows the app database', () => {
  const pathOf = () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-protection-'));
    return join(dir, 'bg-agents.sqlite');
  };
  const seed = async (path: string, targetKey?: string) => {
    const store = openDurableStore(path, targetKey);
    await store.exec('CREATE TABLE notes (text TEXT)');
    await store.run('INSERT INTO notes VALUES (?)', 'durable conversation');
    await store.close();
  };
  const check = async (path: string, targetKey?: string) => {
    const store = openDurableStore(path, targetKey);
    expect(await store.all('SELECT text FROM notes')).toEqual([{ text: 'durable conversation' }]);
    await store.close();
  };

  it('creates and reopens a durable plaintext store without any key', async () => {
    const path = pathOf();
    await seed(path);
    await check(path);
    expect(encryption.isPlainDatabase(path)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('preserves rows through plaintext → encrypted restarts', async () => {
    const path = pathOf();
    await seed(path);
    await check(path, key);
    expect(encryption.isPlainDatabase(path)).toBe(false);
    expect(encryption.keyOpens(path, key)).toBe(true);
    expect(existsSync(`${path}.plaintext`)).toBe(false);
    await check(path, key);
  });

  it('retains encrypted bytes with missing/wrong key, then can retry with the original key', async () => {
    const path = pathOf();
    await seed(path, key);
    const original = readFileSync(path);
    expect(() => openDurableStore(path)).toThrow(/original key.*retained/i);
    expect(readFileSync(path)).toEqual(original);
    expect(() => openDurableStore(path, 'ef'.repeat(32))).toThrow();
    expect(readFileSync(path)).toEqual(original);
    await check(path, key);
  });

  it('rolls back encryption if opening the verified replacement fails', async () => {
    const path = pathOf();
    await seed(path);
    vi.spyOn(encryption, 'useKey').mockImplementationOnce(() => { throw new Error('replacement open failed'); });
    expect(() => openDurableStore(path, key)).toThrow('replacement open failed');
    expect(encryption.isPlainDatabase(path)).toBe(true);
    expect(existsSync(`${path}.plaintext`)).toBe(false);
    await check(path);
    await check(path, key);
  });

  it.each(['.plaintext', '.encrypted', '.encrypting', '.decrypting'])('retains recovery artifacts from an interrupted transition: %s', async (suffix) => {
    const path = pathOf();
    await seed(path);
    writeFileSync(`${path}${suffix}`, 'recovery original');
    expect(() => openDurableStore(path, key)).toThrow(/recovery/);
    expect(readFileSync(`${path}${suffix}`, 'utf8')).toBe('recovery original');
    expect(encryption.isPlainDatabase(path)).toBe(true);
  });
});

const owner = new URL('./fixtures/competing-owner.mjs', import.meta.url).pathname;
const note = () => JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as { pid: number; epoch: number };

describe('takeOwnerLock (one process owns the store)', () => {
  it('admits exactly one of two processes that contend for the unowned folder together', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-competing-'));
    const workers = Array.from({ length: 2 }, () => spawn(process.execPath, [owner, dir]));
    const exited = workers.map((worker) => new Promise((resolve) => worker.once('exit', resolve)));
    const output = workers.map(() => '');
    const errors = workers.map(() => '');
    workers.forEach((worker, i) => {
      worker.stdout.on('data', (chunk) => { output[i] += chunk; });
      worker.stderr.on('data', (chunk) => { errors[i] += chunk; });
    });
    try {
      await expect.poll(() => workers.every((worker) => existsSync(join(dir, `ready-${worker.pid}`))), { timeout: 8000 }).toBe(true);
      writeFileSync(join(dir, 'acquire'), '');
      await expect.poll(() => output.filter((value) => value.includes('\n')).length, { timeout: 8000 }).toBe(2);
      expect(output.map((value) => JSON.parse(value.trim())).filter((value) => value.owned), errors.join('\n')).toHaveLength(1);
    } finally {
      workers.forEach((worker) => worker.kill('SIGKILL'));
      await Promise.all(exited);
    }
  }, 20_000);

  it('takes a free folder with epoch 1, refuses a second host with or without the note, keeps the epoch across a clean release, and ignores a repeated release of an old handle', () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-lock-'));
    const first = takeOwnerLock(dir);
    try {
      expect(first.epoch).toBe(1);
      expect(note()).toMatchObject({ pid: process.pid, epoch: 1 });
      // Two hosts inside one backend must not overlap either, and the note is not what refuses them.
      expect(() => takeOwnerLock(dir)).toThrow(StoreOwnedError);
      rmSync(join(dir, LOCK_FILE));
      expect(() => takeOwnerLock(dir)).toThrow(StoreOwnedError);
    } finally {
      first.release();
    }
    const next = takeOwnerLock(dir);
    try {
      expect(next.epoch).toBe(2);
      first.release();
      expect(note()).toMatchObject({ pid: process.pid, epoch: 2 });
      expect(() => takeOwnerLock(dir)).toThrow(StoreOwnedError);
    } finally {
      next.release();
    }
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('diagnostic note failures cannot refuse SQLite ownership or release', () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-unwritable-note-'));
    // A stale directory where the note would go makes rename fail even though the owner database is writable.
    mkdirSync(join(dir, LOCK_FILE));
    const first = takeOwnerLock(dir);
    try {
      expect(first.epoch).toBe(1);
      expect(() => takeOwnerLock(dir)).toThrow(StoreOwnedError);
    } finally { first.release(); }
    const next = takeOwnerLock(dir);
    try { expect(next.epoch).toBe(2); }
    finally { next.release(); }
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });

  it('is not refused by a stale note that names a live, unrelated process: the free owner database admits, and its epoch is the one that counts', async () => {
    // Regression. A crashed owner leaves its note; the OS may hand its pid to any later process. The lock once admitted
    // on the note (a live pid refused with StoreOwnedError before the owner database was even opened) and took the
    // larger of the two epochs, so a reused pid shut background agents off until someone deleted the file by hand.
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-stale-note-'));
    takeOwnerLock(dir).release(); // the owner database knows epoch 1
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: unrelated.pid, epoch: 7, takenAt: Date.now() }));
      const lock = takeOwnerLock(dir);
      try {
        expect(lock.epoch).toBe(2);
        expect(note()).toMatchObject({ pid: process.pid, epoch: 2 });
      } finally {
        lock.release();
      }
    } finally {
      unrelated.kill('SIGKILL');
      await new Promise((resolve) => unrelated.once('exit', resolve));
    }
  });

  it('names the process that holds the owner database while it lives, and takes over with the next epoch once it is dead', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-foreign-owner-'));
    const holder = spawn(process.execPath, [owner, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    let output = '';
    holder.stdout.on('data', (chunk) => { output += chunk; });
    try {
      await expect.poll(() => existsSync(join(dir, `ready-${holder.pid}`)), { timeout: 8000 }).toBe(true);
      writeFileSync(join(dir, 'acquire'), '');
      await expect.poll(() => output.includes('\n'), { timeout: 8000 }).toBe(true);
      expect(JSON.parse(output.trim())).toEqual({ owned: true, epoch: 1 });
      expect(() => takeOwnerLock(dir)).toThrow(new StoreOwnedError(holder.pid));
    } finally {
      holder.kill('SIGKILL');
      await exited;
    }
    const next = takeOwnerLock(dir);
    try {
      expect(next.epoch).toBe(2);
      expect(note()).toMatchObject({ pid: process.pid, epoch: 2 });
    } finally {
      next.release();
    }
  }, 20_000);
});
