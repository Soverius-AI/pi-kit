import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as encryption from '../db/encryption';
import { LOCK_FILE, openDurableStore, StoreOwnedError, takeOwnerLock } from './durable-storage';

const key = 'ab'.repeat(32);
let dir: string;
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('openDurableStore', async () => {
  it('uses native async SQL, rolls back, and drains accepted operations on close', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-store-'));
    const path = join(dir, 'bg-agents.sqlite');
    const store = await openDurableStore(path, key);
    await store.exec('CREATE TABLE notes (text TEXT)');
    await store.run('INSERT INTO notes VALUES (?)', 'one');
    await expect(
      store.transaction(async (tx) => {
        await tx.run('INSERT INTO notes VALUES (?)', 'rolled back');
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    const write = store.run('INSERT INTO notes VALUES (?)', 'two');
    await store.close();
    await write;
    await expect(store.run('SELECT 1')).rejects.toThrow('closing');
    const reopened = await openDurableStore(path);
    expect(await reopened.all('SELECT text FROM notes ORDER BY rowid')).toEqual([{ text: 'one' }, { text: 'two' }]);
    await reopened.close();
    expect(encryption.isPlainDatabase(path)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('serializes transactions exclusively with FIFO top-level SQL, and rejects escaped executors', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-fifo-'));
    const store = await openDurableStore(join(dir, 'bg-agents.sqlite'));
    await store.exec('CREATE TABLE notes (text TEXT)');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let escaped: Parameters<Parameters<typeof store.transaction>[0]>[0] | undefined;
    const transaction = store.transaction(async (tx) => {
      escaped = tx;
      await tx.run('INSERT INTO notes VALUES (?)', 'first');
      entered();
      await gate;
      await tx.run('INSERT INTO notes VALUES (?)', 'second');
    });
    await started;
    const outside = store.run('INSERT INTO notes VALUES (?)', 'third');
    release();
    await Promise.all([transaction, outside]);
    await expect(escaped!.run('SELECT 1')).rejects.toThrow('ended');
    expect(await store.all('SELECT text FROM notes ORDER BY rowid')).toEqual([
      { text: 'first' },
      { text: 'second' },
      { text: 'third' },
    ]);
    await store.close();
  });

  it('refuses encrypted bytes with an actionable message and never alters them, even with a key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-encrypted-'));
    const path = join(dir, 'bg-agents.sqlite');
    const bytes = Buffer.alloc(4096, 0x91);
    writeFileSync(path, bytes);
    await expect(openDurableStore(path)).rejects.toThrow(/encrypted.*retained.*recover/i);
    await expect(openDurableStore(path, key)).rejects.toThrow(/encrypted.*retained/i);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it.each(['.plaintext', '.encrypted', '.encrypting', '.decrypting'])(
    'retains recovery artifacts: %s',
    async (suffix) => {
      dir = mkdtempSync(join(tmpdir(), 'pk-bg-recovery-'));
      const path = join(dir, 'bg-agents.sqlite');
      writeFileSync(path + suffix, 'recovery original');
      await expect(openDurableStore(path)).rejects.toThrow(/recovery/);
      expect(readFileSync(path + suffix, 'utf8')).toBe('recovery original');
    },
  );
});

const owner = new URL('./fixtures/competing-owner.mjs', import.meta.url).pathname;
const note = () => JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as { pid: number; epoch: number };

describe('takeOwnerLock (one process owns the store)', async () => {
  it('admits exactly one of two processes that contend for the unowned folder together', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-competing-'));
    const workers = Array.from({ length: 2 }, () => spawn(process.execPath, [owner, dir]));
    const exited = workers.map((worker) => new Promise((resolve) => worker.once('exit', resolve)));
    const output = workers.map(() => '');
    const errors = workers.map(() => '');
    workers.forEach((worker, i) => {
      worker.stdout.on('data', (chunk) => {
        output[i] += chunk;
      });
      worker.stderr.on('data', (chunk) => {
        errors[i] += chunk;
      });
    });
    try {
      await expect
        .poll(() => workers.every((worker) => existsSync(join(dir, `ready-${worker.pid}`))), { timeout: 8000 })
        .toBe(true);
      writeFileSync(join(dir, 'acquire'), '');
      await expect.poll(() => output.filter((value) => value.includes('\n')).length, { timeout: 8000 }).toBe(2);
      expect(
        output.map((value) => JSON.parse(value.trim())).filter((value) => value.owned),
        errors.join('\n'),
      ).toHaveLength(1);
    } finally {
      workers.forEach((worker) => worker.kill('SIGKILL'));
      await Promise.all(exited);
    }
  }, 20_000);

  it('takes a free folder with epoch 1, refuses a second host with or without the note, keeps the epoch across a clean release, and ignores a repeated release of an old handle', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-lock-'));
    const first = await takeOwnerLock(dir);
    try {
      expect(first.epoch).toBe(1);
      expect(note()).toMatchObject({ pid: process.pid, epoch: 1 });
      // Two hosts inside one backend must not overlap either, and the note is not what refuses them.
      await expect(takeOwnerLock(dir)).rejects.toThrow(StoreOwnedError);
      rmSync(join(dir, LOCK_FILE));
      await expect(takeOwnerLock(dir)).rejects.toThrow(StoreOwnedError);
    } finally {
      await first.release();
    }
    const next = await takeOwnerLock(dir);
    try {
      expect(next.epoch).toBe(2);
      await first.release();
      expect(note()).toMatchObject({ pid: process.pid, epoch: 2 });
      await expect(takeOwnerLock(dir)).rejects.toThrow(StoreOwnedError);
    } finally {
      await next.release();
    }
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('diagnostic note failures cannot refuse SQLite ownership or release', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-unwritable-note-'));
    // A stale directory where the note would go makes rename fail even though the owner database is writable.
    mkdirSync(join(dir, LOCK_FILE));
    const first = await takeOwnerLock(dir);
    try {
      expect(first.epoch).toBe(1);
      await expect(takeOwnerLock(dir)).rejects.toThrow(StoreOwnedError);
    } finally {
      await first.release();
    }
    const next = await takeOwnerLock(dir);
    try {
      expect(next.epoch).toBe(2);
    } finally {
      await next.release();
    }
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });

  it('is not refused by a stale note that names a live, unrelated process: the free owner database admits, and its epoch is the one that counts', async () => {
    // Regression. A crashed owner leaves its note; the OS may hand its pid to any later process. The lock once admitted
    // on the note (a live pid refused with StoreOwnedError before the owner database was even opened) and took the
    // larger of the two epochs, so a reused pid shut background agents off until someone deleted the file by hand.
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-stale-note-'));
    await (await takeOwnerLock(dir)).release(); // the owner database knows epoch 1
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: unrelated.pid, epoch: 7, takenAt: Date.now() }));
      const lock = await takeOwnerLock(dir);
      try {
        expect(lock.epoch).toBe(2);
        expect(note()).toMatchObject({ pid: process.pid, epoch: 2 });
      } finally {
        await lock.release();
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
    holder.stdout.on('data', (chunk) => {
      output += chunk;
    });
    try {
      await expect.poll(() => existsSync(join(dir, `ready-${holder.pid}`)), { timeout: 8000 }).toBe(true);
      writeFileSync(join(dir, 'acquire'), '');
      await expect.poll(() => output.includes('\n'), { timeout: 8000 }).toBe(true);
      expect(JSON.parse(output.trim())).toEqual({ owned: true, epoch: 1 });
      await expect(takeOwnerLock(dir)).rejects.toThrow(new StoreOwnedError(holder.pid));
    } finally {
      holder.kill('SIGKILL');
      await exited;
    }
    const next = await takeOwnerLock(dir);
    try {
      expect(next.epoch).toBe(2);
      expect(note()).toMatchObject({ pid: process.pid, epoch: 2 });
    } finally {
      await next.release();
    }
  }, 20_000);
});
