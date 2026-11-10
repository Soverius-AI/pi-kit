import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerFilesystem } from '../lib/worker-fs.js';

const signal = new AbortController().signal;

async function withWorkspace(use: (dir: string, files: WorkerFilesystem) => Promise<void>) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-fs-')));
  try {
    await use(dir, new WorkerFilesystem(dir, dir, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Settles `operation`, or unblocks a regressed open(2) by opening the FIFO's other end, so the process can still exit. */
async function settle(operation: Promise<unknown>, fifo: string, unblock: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    operation.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    new Promise((resolve) => (timer = setTimeout(() => resolve('blocked'), 2000))),
  ]);
  clearTimeout(timer);
  if (outcome === 'blocked') {
    await (await open(fifo, unblock | constants.O_NONBLOCK)).close();
    await operation.catch(() => undefined);
  }
  return outcome;
}

test('readFile and writeFile refuse a FIFO without blocking', { skip: process.platform === 'win32' }, async () =>
  withWorkspace(async (dir, files) => {
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const read = await settle(files.run('readFile', [fifo], signal), fifo, constants.O_WRONLY);
    assert.equal((read as { code?: unknown }).code, 'NOT_REGULAR_FILE');
    const unread = await settle(files.run('writeFile', [fifo, 'x'], signal), fifo, constants.O_RDONLY);
    assert.equal((unread as { code?: unknown }).code, 'ENXIO');
    const reader = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const written = await settle(files.run('writeFile', [fifo, 'x'], signal), fifo, constants.O_RDONLY);
      assert.equal((written as { code?: unknown }).code, 'NOT_REGULAR_FILE');
    } finally {
      await reader.close();
    }
  }),
);

test('writeFile honours flags and mode; readFile bounds length and size', async () =>
  withWorkspace(async (dir, files) => {
    const file = path.join(dir, 'a.txt');
    await files.run('writeFile', [file, 'one', { flag: 'wx', mode: 0o600 }], signal);
    await assert.rejects(files.run('writeFile', [file, 'two', { flag: 'wx' }], signal), { code: 'EEXIST' });
    await files.run('writeFile', [file, '+', { flag: 'a' }], signal);
    assert.equal(await readFile(file, 'utf8'), 'one+');
    await files.run('writeFile', [file, Buffer.from([0, 255])], signal);
    assert.deepEqual(await files.run('readFile', [file], signal), Buffer.from([0, 255]));
    assert.deepEqual(await files.run('readFile', ['a.txt', { length: 1 }], signal), Buffer.from([0]));
    await assert.rejects(files.run('writeFile', [file, 'x', { flag: 'r+' }], signal), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(files.run('readFile', [file, { encoding: 'utf8' }], signal), { code: 'INVALID_ARGUMENT' });
    await writeFile(path.join(dir, 'big'), Buffer.alloc(WorkerFilesystem.MAX_FILE + 1));
    await assert.rejects(files.run('readFile', ['big'], signal), { code: 'FILE_LIMIT' });
    assert.equal(((await files.run('readFile', ['big', { length: 4 }], signal)) as Buffer).length, 4);
    await assert.rejects(files.run('rename', [file, file], signal), { code: 'UNSUPPORTED_OPERATION' });
  }));

test('the caller spelling of the workspace maps onto the canonical path', () => {
  const files = new WorkerFilesystem('/private/var/w', '/var/w', '/private/var/t');
  assert.equal(files.resolve('/var/w/a'), '/private/var/w/a');
  assert.equal(files.resolve('a'), '/private/var/w/a');
  assert.equal(files.resolve('/var/w-other/a'), '/var/w-other/a');
  assert.equal(files.resolve('/var/w/..x'), '/private/var/w/..x');
  assert.throws(() => files.resolve('a\0b'), { code: 'INVALID_ARGUMENT' });
});
