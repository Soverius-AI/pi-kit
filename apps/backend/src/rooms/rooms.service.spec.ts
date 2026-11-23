import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOMS_SETTING_KEY } from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { InstanceRepository } from '../db/instance.repository';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { RoomsEnabledGuard } from './rooms-enabled.guard';
import { RepositoryIdentity } from './repository-identity';
import { RoomsService } from './rooms.service';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomFolders } from './room-folders';
import type { BackendConfig } from '../app/config';

let base: string;
let project: string;
let db: DatabaseService;
let meta: MetaRepository;
let threads: ThreadsRepository;
let service: RoomsService;

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], {
    encoding: 'utf8',
  }).trim();

const thread = async (id: string, cwd: string): Promise<void> => {
  const sessionPath = join(base, `${id}.jsonl`);
  writeFileSync(sessionPath, '{}\n');
  await threads.insertDraft({ id, sessionPath, cwd, baseCommit: null });
};

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-rooms-')));
  project = join(base, 'pi-kit');
  mkdirSync(project);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  db = await DatabaseService.create({ dataDir: join(base, 'data') });
  meta = new MetaRepository(db);
  threads = new ThreadsRepository(db);
  service = new RoomsService(
    new RoomsRepository(db),
    threads,
    new InstanceRepository(db),
    meta,
    new RoomPlaybookFiles(),
  );
  await thread('t1', project);
});

afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('rooms', () => {
  it('creates a room from its purpose without any thread, folder or Git repository', async () => {
    const room = await service.create({ title: 'Personal assistant', summary: 'Remember my preferences.' });
    expect(room).toMatchObject({ title: 'Personal assistant', repository: '', baseCommit: '' });
    expect(await new RoomsRepository(db).get(room.id)).toMatchObject({
      sourceThreadId: null,
      projectFolder: null,
      summary: 'Remember my preferences.',
    });
  });

  it('rejects a personal room with a requested existing playbook before creating a room or folder', async () => {
    const dataDir = join(base, 'data');
    const rooms = new RoomsRepository(db);
    const personal = new RoomsService(
      rooms,
      threads,
      new InstanceRepository(db),
      meta,
      new RoomPlaybookFiles(new RoomFolders({ dataDir } as BackendConfig)),
    );
    await expect(personal.create({ title: 'Personal', summary: 'My notes', playbook: 'daily-brief' })).rejects.toThrow(
      'Create the personal room first and add a playbook, or select a project folder',
    );
    expect(await rooms.active()).toEqual([]);
    expect(existsSync(join(dataDir, 'rooms'))).toBe(false);
  });

  it('previews a room from a thread: origin as the repository, the branch, HEAD and uncommitted files', async () => {
    git('remote', 'add', 'origin', 'git@github.com:acme/pi-kit.git');
    writeFileSync(join(project, 'b.txt'), 'b\n');
    expect(await service.preview('t1')).toEqual({
      title: '',
      repository: 'github.com/acme/pi-kit',
      branch: 'main',
      baseCommit: git('rev-parse', 'HEAD'),
      uncommittedFiles: 1,
    });
  });

  it('names an https remote without credentials, and a folder without a remote by its name', async () => {
    expect((await service.preview('t1')).repository).toBe('pi-kit');
    git('remote', 'add', 'origin', 'https://user:secret@github.com/acme/pi-kit.git');
    expect((await service.preview('t1')).repository).toBe('github.com/acme/pi-kit');
  });

  it('refuses an unknown thread and previews a personal room from a non-Git thread', async () => {
    await expect(service.preview('missing')).rejects.toBeInstanceOf(NotFoundException);
    const plain = join(base, 'plain');
    mkdirSync(plain);
    await thread('t2', plain);
    expect(await service.preview('t2')).toMatchObject({
      repository: '',
      baseCommit: '',
      branch: null,
      uncommittedFiles: 0,
    });
    const personal = await service.create({ threadId: 't2', title: 'Personal', summary: 'My notes' });
    expect(personal).toMatchObject({ repository: '', baseCommit: '' });
  });

  it('creates rooms from threads with the base read here, newest first', async () => {
    const first = await service.create(
      { threadId: 't1', title: 'Watcher fix on Linux', summary: 'Run the tests.' },
      1000,
    );
    const second = await service.create({ threadId: 't1', title: 'Event batching', summary: '' }, 2000);
    expect(first).toMatchObject({
      hostInstanceId: db.instanceId,
      repository: 'pi-kit',
      baseCommit: git('rev-parse', 'HEAD'),
    });
    expect((await service.hosted()).map((room) => room.id)).toEqual([second.id, first.id]);
  });

  it('creates a room from a repository and base commit in a known clone, and refuses without one', async () => {
    git('remote', 'add', 'origin', 'git@github.com:acme/pi-kit.git');
    const head = git('rev-parse', 'HEAD');
    const offer = { title: 'Remote start', summary: '', repository: 'github.com/acme/pi-kit', baseCommit: head };
    await expect(service.create(offer)).rejects.toBeInstanceOf(ConflictException);
    await meta.touchWorkspace(project);
    const room = await service.create(offer);
    expect(room).toMatchObject({ repository: 'github.com/acme/pi-kit', baseCommit: head });
    expect((await new RoomsRepository(db).get(room.id))?.projectFolder).toBe(project);
    await expect(service.create({ ...offer, baseCommit: 'f'.repeat(40) })).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a project room from a repository folder and a personal room from a plain folder', async () => {
    const other = join(base, 'other');
    execFileSync('git', ['clone', '-q', project, other]);
    const room = await service.create({ title: 'From a server', summary: '', projectFolder: join(other, '.') });
    expect(room).toMatchObject({ repository: project, baseCommit: git('rev-parse', 'HEAD') });
    expect((await new RoomsRepository(db).get(room.id))?.projectFolder).toBe(other);
    expect((await meta.listWorkspaces()).map((workspace) => workspace.cwd)).toContain(other);
    expect(await service.create({ title: 'Personal folder', summary: '', projectFolder: base })).toMatchObject({
      repository: '',
      baseCommit: '',
    });
    await expect(
      service.create({ title: 'Missing', summary: '', projectFolder: join(base, 'missing') }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('asks which folder when several clones match, skips worktrees, and lists clean clones first', async () => {
    git('remote', 'add', 'origin', 'git@github.com:acme/pi-kit.git');
    const head = git('rev-parse', 'HEAD');
    const second = join(base, 'second');
    execFileSync('git', ['clone', '-q', project, second]);
    execFileSync('git', ['-C', second, 'remote', 'set-url', 'origin', 'https://github.com/acme/pi-kit.git']);
    const worktree = join(base, 'worktree');
    git('worktree', 'add', '-q', '-b', 'side', worktree);
    writeFileSync(join(project, 'a.txt'), 'changed\n');
    await meta.touchWorkspace(project, 3);
    await meta.touchWorkspace(second, 2);
    await meta.touchWorkspace(worktree, 4);
    expect(await service.clones('github.com/acme/pi-kit', head)).toEqual([
      { folder: second, clean: true },
      { folder: project, clean: false },
    ]);
    expect(await RepositoryIdentity.findClone(meta, 'github.com/acme/pi-kit', head)).toBe(second);
    const offer = { title: 'Remote start', summary: '', repository: 'github.com/acme/pi-kit', baseCommit: head };
    await expect(service.create(offer)).rejects.toThrow(`Several projects here are clones`);
    await expect(service.create({ ...offer, projectFolder: worktree })).rejects.toBeInstanceOf(ConflictException);
    const room = await service.create({ ...offer, projectFolder: project });
    expect((await new RoomsRepository(db).get(room.id))?.projectFolder).toBe(project);
  });

  it('hides every room route until Rooms (preview) is on', async () => {
    const guard = new RoomsEnabledGuard(meta);
    await expect(guard.canActivate()).rejects.toBeInstanceOf(NotFoundException);
    await meta.setSetting(ROOMS_SETTING_KEY, 'yes');
    await expect(guard.canActivate()).rejects.toBeInstanceOf(NotFoundException);
    await meta.setSetting(ROOMS_SETTING_KEY, true);
    await expect(guard.canActivate()).resolves.toBe(true);
  });
});
