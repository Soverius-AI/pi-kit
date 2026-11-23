import { mkdtemp, mkdir, writeFile, readFile, realpath, readlink, rename, symlink, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import type { BackendConfig } from '../app/config';
import type { PiSessionService } from '../pi/pi-session.service';
import type { ThreadProtectionService } from '../pi/thread-protection.service';
import type { RoomLive } from './room-live';
import { RoomFolders } from './room-folders';
import { RoomWorkspace } from './room-workspace.service';

describe('room workspaces and read-only folder attachments', () => {
  let root: string, dataDir: string, project: string, notes: string;
  let db: DatabaseService, rooms: RoomsRepository, store: RoomAssistantRepository, rows: ThreadsRepository;
  let service: RoomWorkspace;
  let resolver: ((id: string) => Promise<{ readOnlyRoots: string[]; immutablePaths: string[] }>) | undefined;
  const dispose = vi.fn(),
    release = vi.fn(async () => undefined),
    request = vi.fn();
  const cwdOf = vi.fn();
  const protection = {
    setRoomRoots: (value: typeof resolver) => {
      resolver = value;
    },
    binding: async () => ({ mode: 'sandboxed' }),
    prepare: vi.fn(),
    release,
    set: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await realpath(await mkdtemp(join(tmpdir(), 'pi-room-workspace-')));
    dataDir = join(root, 'Library', 'data');
    project = join(root, 'project');
    notes = join(root, 'notes');
    await mkdir(project);
    await mkdir(notes);
    await writeFile(join(project, 'kept.md'), 'project text');
    await writeFile(join(notes, 'notes.md'), 'meeting agenda');
    db = await DatabaseService.create({ dataDir });
    rooms = new RoomsRepository(db);
    store = new RoomAssistantRepository(db);
    rows = new ThreadsRepository(db);
    await rooms.insert({
      id: 'a',
      title: 'Personal',
      summary: '',
      repository: '',
      baseCommit: '',
      sourceThreadId: null,
      projectFolder: null,
      createdAt: 1,
    });
    await rooms.insert({
      id: 'b',
      title: 'Project',
      summary: '',
      repository: 'repo',
      baseCommit: 'a'.repeat(40),
      sourceThreadId: null,
      projectFolder: project,
      createdAt: 1,
    });
    for (const id of ['lead-a', 'lead-b', 'consult'])
      await rows.insertDraft({ id, sessionPath: join(root, `${id}.jsonl`), cwd: project, baseCommit: null });
    await writeFile(join(root, 'lead-b.jsonl'), 'original persisted history\n');
    await rooms.setLead('a', 'lead-a');
    await rooms.setLead('b', 'lead-b');
    await new RoomPlaybooksRepository(db).addConsultThread('consult', 'b', 'research');
    cwdOf.mockReturnValue(project);
    request.mockResolvedValue({ content: [{ type: 'text', text: 'notes.md:1:meeting agenda' }] });
    protection.prepare.mockResolvedValue({ state: 'active', request });
    const folders = new RoomFolders({ dataDir } as BackendConfig);
    service = new RoomWorkspace(
      store,
      rooms,
      folders,
      { cwdOf, dispose } as unknown as PiSessionService,
      protection as unknown as ThreadProtectionService,
      { snapshot: () => [] } as unknown as RoomLive,
      { dataDir },
    );
    service.onModuleInit();
  });
  afterEach(async () => {
    await db.onApplicationShutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('links an approved folder under a stable room cwd, preserves session history, and searches in the sandbox', async () => {
    await service.add('a', { alias: 'notes', target: notes });
    expect(await readlink(join(service.path('a'), 'folders', 'notes'))).toBe(notes);
    cwdOf.mockReturnValue(undefined);
    const cwd = await service.prepare('a', 'lead-a');
    expect(release).toHaveBeenCalledWith('thread:lead-a');
    expect(cwd).toBe(join(dataDir, 'rooms', 'a', 'workspace'));
    expect((await rows.get('lead-a'))?.cwd).toBe(cwd);
    expect((await rows.get('lead-a'))?.sessionCwd).toBe(project);
    expect((await rows.get('lead-a'))?.sessionPath).toBe(join(root, 'lead-a.jsonl'));
    expect((await resolver?.('lead-a'))?.readOnlyRoots).toEqual([notes]);
    expect((await resolver?.('lead-a'))?.immutablePaths).toContain(join(cwd, 'folders'));
    expect(await service.search('a', 'meeting')).toContain('folders/notes');
    expect(request).toHaveBeenCalledWith(
      'pi.grep',
      [expect.objectContaining({ path: notes, literal: true, pattern: 'meeting' }), cwd],
      expect.anything(),
    );
  });

  it('initializes the project link once, revokes both lead and consultant grants, and never deletes the target', async () => {
    await Promise.all([service.ensureProject('b'), service.ensureProject('b')]);
    expect(await store.folders('b')).toHaveLength(1);
    const attached = (await store.folders('b'))[0];
    await service.remove('b', attached.id);
    expect(dispose).toHaveBeenCalledWith('lead-b');
    expect(dispose).toHaveBeenCalledWith('consult');
    expect(release).toHaveBeenCalledWith('thread:lead-b');
    expect(release).toHaveBeenCalledWith('thread:consult');
    await service.ensureProject('b');
    expect(await store.folders('b')).toEqual([]);
    expect(await readFile(join(project, 'kept.md'), 'utf8')).toBe('project text');
    expect(await readFile(join(root, 'lead-b.jsonl'), 'utf8')).toBe('original persisted history\n');
  });

  it('keeps an existing managed scratch project readable without admitting arbitrary application folders', async () => {
    const scratch = join(dataDir, 'scratch', 'project');
    await mkdir(scratch, { recursive: true });
    await rooms.insert({
      id: 'c',
      title: 'Scratch',
      summary: '',
      repository: 'repo',
      baseCommit: 'a'.repeat(40),
      sourceThreadId: null,
      projectFolder: scratch,
      createdAt: 1,
    });
    await service.ensureProject('c');
    expect((await store.folders('c'))[0].canonical).toBe(scratch);
    await expect(service.add('a', { alias: 'scratch', target: scratch })).rejects.toThrow();
  });

  it('refuses application data, home, traversal aliases and unexpectedly retargeted attachments', async () => {
    await expect(service.add('a', { alias: 'escape', target: homedir() })).rejects.toThrow();
    await expect(service.add('a', { alias: 'escape', target: dataDir })).rejects.toThrow();
    await expect(service.add('a', { alias: '../escape', target: notes })).rejects.toThrow();
    await service.add('a', { alias: 'notes', target: notes });
    await rename(notes, notes + '-original');
    await symlink(project, notes);
    expect((await service.list('a'))[0]).toMatchObject({ available: false });
    expect((await resolver?.('lead-a'))?.readOnlyRoots).toEqual([]);
    await expect(readlink(join(service.path('a'), 'folders', 'notes'))).rejects.toThrow();
  });

  it('deactivates an offline root and restarts grants at the next turn while the room remains usable', async () => {
    await service.add('a', { alias: 'notes', target: notes });
    await service.prepare('a', 'lead-a');
    cwdOf.mockReturnValue(service.path('a'));
    const releases = release.mock.calls.length;
    await rename(notes, notes + '-offline');
    expect((await service.list('a'))[0]).toMatchObject({ available: false });
    expect(await service.prepare('a', 'lead-a')).toBe(service.path('a'));
    expect(release.mock.calls.length).toBe(releases + 1);
    expect((await resolver?.('lead-a'))?.readOnlyRoots).toEqual([]);
    expect(await service.output('a', 'memory-brief.md', 'Remembered facts remain available.')).toBe(
      'outputs/memory-brief.md',
    );
    expect(Buffer.from((await service.file('a', 'outputs/memory-brief.md')).data, 'base64').toString()).toContain(
      'Remembered facts',
    );
  });

  it('can initialize an old project room whose source disk is already offline', async () => {
    await rooms.insert({
      id: 'd',
      title: 'Offline source',
      summary: '',
      repository: 'repo',
      baseCommit: 'a'.repeat(40),
      sourceThreadId: null,
      projectFolder: join(root, 'missing-source'),
      createdAt: 1,
    });
    await rows.insertDraft({ id: 'lead-d', sessionPath: join(root, 'lead-d.jsonl'), cwd: project, baseCommit: null });
    await rooms.setLead('d', 'lead-d');
    await service.ensureProject('d');
    expect((await service.list('d'))[0]).toMatchObject({ alias: 'project', available: false });
    expect(await service.prepare('d', 'lead-d')).toBe(service.path('d'));
    expect((await resolver?.('lead-d'))?.readOnlyRoots).toEqual([]);
  });

  it('keeps generated files in owned directories, rejects symlink reads and breaks hard links on replacement', async () => {
    const output = await service.output('a', 'brief.md', 'meeting brief');
    expect(output).toBe('outputs/brief.md');
    expect(Buffer.from((await service.file('a', output)).data, 'base64').toString()).toBe('meeting brief');
    await expect(service.file('a', 'outputs/../../private')).rejects.toThrow();
    await link(join(project, 'kept.md'), join(service.path('a'), 'outputs', 'hard.md'));
    await service.output('a', 'hard.md', 'new output');
    expect(await readFile(join(project, 'kept.md'), 'utf8')).toBe('project text');
    await symlink(join(project, 'kept.md'), join(service.path('a'), 'inbox', 'escape.txt'));
    await expect(service.readUpload('a', 'inbox/escape.txt')).rejects.toThrow();
    const upload = await service.upload('a', 1, '../../agenda.txt', Buffer.from('incoming'));
    expect(upload).toMatch(/^inbox\/1-/);
    expect((await service.readUpload('a', upload)).toString()).toBe('incoming');
    await rm(join(service.path('a'), 'outputs'), { recursive: true });
    await symlink(project, join(service.path('a'), 'outputs'));
    await expect(service.output('a', 'escaped.txt', 'unsafe')).rejects.toThrow(/directory changed/);
    await expect(service.files('a')).rejects.toThrow(/directory changed/);
  });
});
