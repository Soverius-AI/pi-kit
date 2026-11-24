import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  readlink,
  rename,
  symlink,
  rm,
  link,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaRepository } from '../db/meta.repository';
import { DatabaseService } from '../db/database.service';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { ThreadProtectionRepository } from '../db/thread-protection.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { ROOMS_SANDBOX_SETTING_KEY } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import type { PiSessionService } from '../pi/pi-session.service';
import { SandboxPackage } from '../pi/thread-protection.service';
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
    binding: vi.fn(),
    status: vi.fn(),
    prepare: vi.fn(),
    release,
    set: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    const { SandboxPolicy } = await import(pathToFileURL(join(SandboxPackage.dir(), 'dist/core.js')).href);
    vi.spyOn(SandboxPackage, 'load').mockResolvedValue({ SandboxPolicy } as never);
    protection.binding.mockResolvedValue({ mode: 'sandboxed', generation: 1 });
    protection.status.mockImplementation(async (id: string) => {
      const binding = await protection.binding(id);
      return {
        ...binding,
        state: binding.mode === 'sandboxed' ? 'idle' : 'bypass',
        experimentalWindowsAccepted: false,
        platform: process.platform,
        reason: null,
      };
    });
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
      new MetaRepository(db),
    );
    service.onModuleInit();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.onApplicationShutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('reads effective defaults without creating a lead, workspace, links, or sandbox', async () => {
    await db.db.prepare('UPDATE rooms SET lead_thread_id=NULL').run();
    const before = await rows.list({ includeArchived: true });
    expect(await service.protectionOf('a')).toMatchObject({
      mode: 'sandboxed',
      state: 'idle',
      generation: 0,
      reason: null,
    });
    expect(await service.protectionOf('b')).toMatchObject({
      mode: 'bypass',
      state: 'bypass',
      generation: 0,
      reason: null,
    });
    await new MetaRepository(db).setSetting(ROOMS_SANDBOX_SETTING_KEY, true);
    expect(await service.protectionOf('b')).toMatchObject({ mode: 'sandboxed', state: 'idle', generation: 0 });
    expect((await rooms.get('a'))?.leadThreadId).toBeNull();
    expect(await rows.list({ includeArchived: true })).toEqual(before);
    expect(await store.workspaceVersion('a')).toBe(0);
    expect(await store.folders('a')).toEqual([]);
    await expect(realpath(service.path('a'))).rejects.toThrow();
    expect(protection.status).not.toHaveBeenCalled();
    expect(protection.prepare).not.toHaveBeenCalled();
    expect(protection.set).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await expect(service.protectionOf('missing')).rejects.toThrow('No room with this id.');
  });

  it('reports a generation-zero lead’s effective workspace default instead of its raw default bypass', async () => {
    protection.binding.mockResolvedValue({ mode: 'bypass', generation: 0 });
    expect(await service.protectionOf('a')).toMatchObject({ mode: 'sandboxed', state: 'idle', generation: 0 });
    expect(await service.protectionOf('b')).toMatchObject({ mode: 'bypass', state: 'bypass', generation: 0 });
    expect(protection.prepare).not.toHaveBeenCalled();
    expect(protection.set).not.toHaveBeenCalled();
    await expect(realpath(service.path('a'))).rejects.toThrow();
  });

  it.each(['unavailable', 'setup-required', 'recovery-required'] as const)(
    'preserves explicit %s status and technical reason without preparing protection',
    async (state) => {
      const actual = {
        mode: 'sandboxed',
        state,
        generation: 2,
        experimentalWindowsAccepted: false,
        platform: process.platform,
        reason: 'Original protection reason',
      };
      protection.status.mockResolvedValue(actual);
      expect(await service.protectionOf('a')).toEqual(actual);
      expect(protection.prepare).not.toHaveBeenCalled();
      expect(protection.set).not.toHaveBeenCalled();
    },
  );

  it('preserves explicit host mode and recovery state when resolving a workspace default', async () => {
    const actual = {
      mode: 'bypass',
      state: 'bypass',
      generation: 2,
      experimentalWindowsAccepted: false,
      platform: process.platform,
      reason: null,
    };
    protection.status.mockResolvedValue(actual);
    expect(await service.protectionOf('a')).toEqual(actual);
    protection.binding.mockResolvedValue({ mode: 'bypass', generation: 0 });
    protection.status.mockResolvedValue({
      ...actual,
      state: 'recovery-required',
      generation: 0,
      reason: 'Confirm previous sandbox cleanup',
    });
    expect(await service.protectionOf('a')).toMatchObject({
      mode: 'sandboxed',
      state: 'recovery-required',
      generation: 0,
      reason: 'Confirm previous sandbox cleanup',
    });
  });

  it('keeps path, folder inspection, grants and empty file listing read-only, and recreates owned directories on prepare', async () => {
    const cwd = service.path('a');
    await expect(realpath(cwd)).rejects.toThrow();
    expect(await service.list('a')).toEqual([]);
    expect(await service.files('a')).toEqual([]);
    expect((await resolver?.('lead-a'))?.readOnlyRoots).toEqual([]);
    await expect(realpath(cwd)).rejects.toThrow();
    await service.add('a', { alias: 'notes', target: notes });
    await service.prepare('a', 'lead-a');
    cwdOf.mockReturnValue(cwd);
    await rm(cwd, { recursive: true });
    expect(await service.prepare('a', 'lead-a')).toBe(cwd);
    expect(await realpath(join(cwd, 'outputs'))).toBe(join(cwd, 'outputs'));
    expect(await readlink(join(cwd, 'folders', 'notes'))).toBe(notes);
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

  it('keeps workspace and protection choices separate while defaulting owned workspaces to a sandbox', async () => {
    const meta = new MetaRepository(db);
    protection.binding.mockResolvedValue({ mode: 'bypass', generation: 0 });
    await service.ensureProject('b');
    expect(await service.execution('b', 'lead-b')).toEqual({ cwd: project, workspace: false, sandbox: false });
    expect(await service.prepare('b', 'lead-b')).toBe(project);
    expect(protection.set).not.toHaveBeenCalled();
    expect(protection.prepare).not.toHaveBeenCalled();
    expect((await resolver?.('lead-b'))?.readOnlyRoots).toEqual([]);
    await meta.setSetting(ROOMS_SANDBOX_SETTING_KEY, true);
    expect((await service.execution('b', 'lead-b')).sandbox).toBe(true);
    protection.binding.mockResolvedValue({ mode: 'bypass', generation: 2 });
    expect((await service.execution('b', 'lead-b')).sandbox).toBe(false);
    await service.add('b', { alias: 'notes', target: notes });
    expect(await service.execution('b', 'lead-b')).toEqual({ cwd: service.path('b'), workspace: true, sandbox: false });
    await service.prepare('b', 'lead-b');
    expect(protection.set).not.toHaveBeenCalled();
    expect(protection.prepare).not.toHaveBeenCalled();
    protection.binding.mockResolvedValue({ mode: 'bypass', generation: 0 });
    expect((await service.execution('b', 'lead-b')).sandbox).toBe(true);
    await service.prepare('b', 'lead-b');
    expect(protection.set).toHaveBeenCalledWith(
      'lead-b',
      service.path('b'),
      { mode: 'sandboxed' },
      expect.any(Function),
    );
    await service.remove('b', (await store.folders('b')).find((folder) => folder.alias === 'notes')!.id);
    expect((await service.execution('b', 'lead-b')).workspace).toBe(true);
    expect((await service.execution('a', 'lead-a')).sandbox).toBe(true);
  });

  it('preserves persisted explicit host mode for personal and linked rooms across preparation and workspace service reopening', async () => {
    const bindings = new ThreadProtectionRepository(db);
    await new MetaRepository(db).setSetting(ROOMS_SANDBOX_SETTING_KEY, true);
    await service.add('b', { alias: 'notes', target: notes });
    for (const id of ['lead-a', 'lead-b'])
      await bindings.setBinding(id, { version: 1, mode: 'bypass', generation: 2, experimentalWindowsAccepted: false });
    protection.binding.mockImplementation((id: string) => bindings.binding(id));
    for (const roomId of ['a', 'b']) {
      const threadId = `lead-${roomId}`;
      expect(await service.execution(roomId, threadId)).toEqual({
        cwd: service.path(roomId),
        workspace: true,
        sandbox: false,
      });
      expect(await service.prepare(roomId, threadId)).toBe(service.path(roomId));
    }
    service = new RoomWorkspace(
      store,
      rooms,
      new RoomFolders({ dataDir } as BackendConfig),
      { cwdOf, dispose } as unknown as PiSessionService,
      protection as unknown as ThreadProtectionService,
      { snapshot: () => [] } as unknown as RoomLive,
      { dataDir },
      new MetaRepository(db),
    );
    service.onModuleInit();
    for (const roomId of ['a', 'b']) {
      const threadId = `lead-${roomId}`;
      await service.prepare(roomId, threadId);
      expect(await bindings.binding(threadId)).toMatchObject({ mode: 'bypass', generation: 2 });
      expect((await rows.get(threadId))?.cwd).toBe(service.path(roomId));
      expect((await service.execution(roomId, threadId)).sandbox).toBe(false);
    }
    expect(protection.set).not.toHaveBeenCalled();
    expect(protection.prepare).not.toHaveBeenCalled();
    expect(await readlink(join(service.path('b'), 'folders', 'notes'))).toBe(notes);
  });

  it('continues to require a working sandbox for an explicitly sandboxed owned workspace', async () => {
    protection.binding.mockResolvedValue({ mode: 'sandboxed', generation: 3 });
    expect((await service.execution('a', 'lead-a')).sandbox).toBe(true);
    protection.prepare.mockResolvedValue({ state: 'unavailable' });
    await expect(service.prepare('a', 'lead-a')).rejects.toThrow('requires an active sandbox');
    expect(protection.set).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'bypass' }),
      expect.anything(),
    );
  });

  it('inspects folders and resolves grants without creating or removing managed symlinks', async () => {
    await service.add('a', { alias: 'notes', target: notes });
    const link = join(service.path('a'), 'folders', 'notes');
    await unlink(link);
    expect((await service.list('a'))[0].available).toBe(true);
    expect((await resolver?.('lead-a'))?.readOnlyRoots).toEqual([notes]);
    await expect(readlink(link)).rejects.toThrow();
    await service.prepare('a', 'lead-a');
    expect(await readlink(link)).toBe(notes);
    await rename(notes, notes + '-old');
    await symlink(project, notes);
    expect((await service.list('a'))[0].available).toBe(false);
    expect((await resolver?.('lead-a'))?.readOnlyRoots).toEqual([]);
    expect(await readlink(link)).toBe(notes);
    await service.prepare('a', 'lead-a');
    await expect(readlink(link)).rejects.toThrow();
  });

  it('allows ordinary content named Library while refusing credential directories', async () => {
    const library = join(root, 'books', 'Library');
    await mkdir(library, { recursive: true });
    await service.add('a', { alias: 'books', target: library });
    expect((await service.list('a'))[0]).toMatchObject({ canonical: library, available: true });
    const credentials = join(root, '.ssh');
    await mkdir(credentials);
    await expect(service.add('a', { alias: 'secrets', target: credentials })).rejects.toThrow(/credential/);
    protection.prepare.mockRejectedValue(new Error('Sandbox unsupported on this platform'));
    await expect(service.prepare('a', 'lead-a')).rejects.toThrow(/Sandbox unsupported/);
    expect(protection.set).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'bypass' }),
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

  it('uses a protected workspace for a non-Git source and keeps invalid automatic links unavailable', async () => {
    const source = join(root, '.ssh', 'personal');
    await mkdir(source, { recursive: true });
    await rooms.insert({
      id: 'personal-source',
      title: 'Personal source',
      summary: '',
      repository: '',
      baseCommit: '',
      sourceThreadId: null,
      projectFolder: source,
      createdAt: 1,
    });
    await rows.insertDraft({
      id: 'personal-lead',
      sessionPath: join(root, 'personal.jsonl'),
      cwd: source,
      baseCommit: null,
    });
    await rooms.setLead('personal-source', 'personal-lead');
    await service.ensureProject('personal-source');
    expect((await service.list('personal-source'))[0]).toMatchObject({ available: false });
    expect(await service.execution('personal-source', 'personal-lead')).toEqual({
      cwd: service.path('personal-source'),
      workspace: true,
      sandbox: true,
    });
    expect(await service.prepare('personal-source', 'personal-lead')).toBe(service.path('personal-source'));
    expect((await resolver?.('personal-lead'))?.readOnlyRoots).toEqual([]);
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
    expect(await readlink(join(service.path('a'), 'folders', 'notes'))).toBe(notes);
    await service.prepare('a', 'lead-a');
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
