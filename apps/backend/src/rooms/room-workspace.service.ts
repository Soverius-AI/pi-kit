import { BadRequestException, ConflictException, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { lstat, realpath, stat, symlink, unlink, readdir, writeFile, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RoomFolder, RoomFolderInput } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadProtectionService } from '../pi/thread-protection.service';
import { RoomFolders } from './room-folders';
import { RoomLive } from './room-live';

@Injectable()
export class RoomWorkspace implements OnModuleInit {
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly preparedRoots = new Map<string, string>();
  constructor(
    private readonly store: RoomAssistantRepository,
    private readonly rooms: RoomsRepository,
    private readonly folders: RoomFolders,
    private readonly sessions: PiSessionService,
    private readonly protection: ThreadProtectionService,
    private readonly live: RoomLive,
    @Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir'>,
  ) {}
  onModuleInit(): void {
    this.protection.setRoomRoots(async (id) => {
      const roomId = await this.store.threadRoom(id);
      if (!roomId) return { readOnlyRoots: [], immutablePaths: [] };
      const folders = await this.list(roomId);
      return {
        readOnlyRoots: folders.filter((folder) => folder.available).map((folder) => folder.canonical),
        immutablePaths: ['folders', 'inbox', 'outputs'].map((name) => join(this.folders.workspace(roomId), name)),
      };
    });
  }
  path(roomId: string): string {
    return this.folders.workspace(roomId);
  }
  async ensureProject(roomId: string): Promise<void> {
    const existing = this.initializing.get(roomId);
    if (existing) return existing;
    const pending = (async () => {
      if ((await this.store.workspaceVersion(roomId)) > 0) return;
      const found = await this.rooms.get(roomId);
      if (!found) throw new BadRequestException('No room with this id.');
      if (found.projectFolder && !(await this.store.folders(roomId)).some((folder) => folder.alias === 'project')) {
        const canonical = await this.validate(found.projectFolder, roomId, true);
        await this.store.addFolder(roomId, 'project', found.projectFolder, canonical);
      }
      // Initialization is durable even when the owner later removes the default link.
      await this.store.markWorkspace(roomId);
    })().finally(() => this.initializing.delete(roomId));
    this.initializing.set(roomId, pending);
    return pending;
  }
  async list(roomId: string): Promise<RoomFolder[]> {
    await this.ownedDirectory(join(this.path(roomId), 'folders'));
    const result = await this.store.folders(roomId);
    for (const folder of result) {
      try {
        if ((await realpath(folder.target)) !== folder.canonical || !(await stat(folder.canonical)).isDirectory())
          throw new Error('The folder target changed or disappeared. Relink it.');
        const link = join(this.path(roomId), 'folders', folder.alias);
        const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        if (!existing) await symlink(folder.canonical, link, process.platform === 'win32' ? 'junction' : 'dir');
        else if (!existing.isSymbolicLink() || (await realpath(link)) !== folder.canonical)
          throw new Error('The managed link changed. Remove and attach this folder again.');
        if (process.platform === 'win32')
          throw new Error('Read-only linked folders are unavailable in the Windows sandbox.');
      } catch (error) {
        folder.available = false;
        folder.reason = error instanceof Error ? error.message : 'Folder unavailable.';
        // A missing or retargeted reference must not remain reachable through a stale alias.
        // Only remove the managed link, never a real file/directory or its target.
        const link = join(this.path(roomId), 'folders', folder.alias);
        const entry = await lstat(link).catch((failure: NodeJS.ErrnoException) => {
          if (failure.code !== 'ENOENT') throw failure;
          return undefined;
        });
        if (entry?.isSymbolicLink()) await unlink(link);
      }
    }
    return result;
  }
  async add(roomId: string, input: RoomFolderInput): Promise<void> {
    await this.idle(roomId);
    const canonical = await this.validate(input.target, roomId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.alias))
      throw new BadRequestException('Use a simple folder alias.');
    if ((await this.store.folders(roomId)).length >= 64)
      throw new BadRequestException('A room can attach at most 64 folders.');
    if ((await this.store.folders(roomId)).some((folder) => folder.alias === input.alias))
      throw new ConflictException('This folder alias already exists.');
    await this.reset(roomId);
    await this.store.addFolder(roomId, input.alias, input.target, canonical);
    await this.list(roomId);
  }
  async remove(roomId: string, id: string): Promise<void> {
    await this.idle(roomId);
    const folder = (await this.store.folders(roomId)).find((folder) => folder.id === id);
    if (!folder) return;
    await this.reset(roomId);
    const path = join(this.path(roomId), 'folders', folder.alias);
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry && !entry.isSymbolicLink())
      throw new ConflictException(
        'The managed link was replaced with a real file or directory; its contents were retained.',
      );
    if (entry) await unlink(path);
    await this.store.removeFolder(roomId, id);
  }
  async prepare(roomId: string, threadId: string): Promise<string> {
    await this.ensureProject(roomId);
    const cwd = this.path(roomId);
    const signature = JSON.stringify(
      (await this.list(roomId)).filter((folder) => folder.available).map((folder) => folder.canonical),
    );
    if (this.sessions.cwdOf(threadId) !== cwd || this.preparedRoots.get(threadId) !== signature) {
      this.sessions.dispose(threadId);
      await this.protection.release(`thread:${threadId}`);
    }
    await this.store.moveThread(threadId, cwd);
    if ((await this.protection.binding(threadId)).mode !== 'sandboxed')
      await this.protection.set(threadId, cwd, { mode: 'sandboxed' }, () => this.sessions.dispose(threadId));
    const sandbox = await this.protection.prepare(threadId, cwd);
    if (!sandbox || sandbox.state !== 'active')
      throw new ConflictException(
        'The room workspace requires an active sandbox. Set up the sandbox in the room protection control.',
      );
    this.preparedRoots.set(threadId, signature);
    await this.store.markWorkspace(roomId);
    return cwd;
  }
  async output(roomId: string, path: string, text: string): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(path))
      throw new BadRequestException('Use a simple output filename.');
    const root = join(this.path(roomId), 'outputs');
    const target = join(root, path);
    if ((await lstat(target).catch(() => undefined))?.isSymbolicLink())
      throw new ConflictException('An output must not be a symlink.');
    await this.writeOwned(root, target, text);
    return `outputs/${path}`;
  }
  async upload(roomId: string, id: number, name: string, bytes: Uint8Array): Promise<string> {
    if (!Number.isSafeInteger(id) || id < 1 || bytes.length > 16 * 1024 * 1024)
      throw new BadRequestException('Invalid room upload.');
    const root = join(this.path(roomId), 'inbox');
    const file = `${id}-${name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-100) || 'attachment'}`;
    await this.writeOwned(root, join(root, file), bytes);
    return `inbox/${file}`;
  }
  async readUpload(roomId: string, path: string): Promise<Buffer> {
    if (!/^inbox\/[a-zA-Z0-9_.-]+$/.test(path)) throw new BadRequestException('Invalid room upload.');
    const root = join(this.path(roomId), 'inbox');
    await this.ownedDirectory(root);
    return this.readOwnedFile(join(root, path.slice('inbox/'.length)), 16 * 1024 * 1024);
  }
  private async writeOwned(root: string, target: string, data: string | Uint8Array): Promise<void> {
    await this.ownedDirectory(root);
    const temp = join(root, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  async files(roomId: string): Promise<{ path: string; size: number }[]> {
    const result: { path: string; size: number }[] = [];
    for (const area of ['inbox', 'outputs']) {
      const root = join(this.path(roomId), area);
      await this.ownedDirectory(root);
      for (const name of (await readdir(root)).sort().slice(-100)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) continue;
        const file = await lstat(join(root, name));
        if (file.isFile() && !file.isSymbolicLink()) result.push({ path: `${area}/${name}`, size: file.size });
      }
    }
    return result;
  }
  async file(roomId: string, path: string): Promise<{ name: string; data: string; mime: string }> {
    if (!/^(inbox|outputs)\/[a-zA-Z0-9_.-]+$/.test(path)) throw new BadRequestException('Invalid room file.');
    const [area, name] = path.split('/');
    const root = join(this.path(roomId), area);
    await this.ownedDirectory(root);
    return {
      name,
      data: (await this.readOwnedFile(join(root, name), 16 * 1024 * 1024)).toString('base64'),
      mime: 'application/octet-stream',
    };
  }
  async search(roomId: string, query: string): Promise<string> {
    if (!query.trim() || query.length > 200) throw new BadRequestException('Search for 1 to 200 characters.');
    const found = await this.rooms.get(roomId);
    if (!found?.leadThreadId) throw new ConflictException('Open the room lead before searching its folders.');
    const cwd = this.path(roomId);
    const client = await this.protection.prepare(found.leadThreadId, cwd);
    if (!client || client.state !== 'active') throw new ConflictException('Folder search requires the room sandbox.');
    const matches: string[] = [];
    for (const folder of await this.list(roomId)) {
      if (!folder.available) continue;
      // Search each approved root explicitly: recursive tools do not all follow directory symlinks.
      // The confined worker enforces the same canonical read grants and credential exclusions as file tools.
      const result = await client.request<{ content: { type: string; text?: string }[] }>(
        'pi.grep',
        [{ pattern: query, path: folder.canonical, ignoreCase: true, literal: true, context: 1, limit: 50 }, cwd],
        { signal: AbortSignal.timeout(10000) },
      );
      const text = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
      if (text.trim()) matches.push(`folders/${folder.alias}:\n${text}`);
      if (matches.join('\n').length > 24000) break;
    }
    return matches.join('\n\n').slice(0, 24000) || 'No matches in the approved linked folders.';
  }
  private async ownedDirectory(root: string): Promise<void> {
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ConflictException('The room file directory changed.');
  }
  private async readOwnedFile(path: string, limit: number): Promise<Buffer> {
    // O_NOFOLLOW checks the final component atomically; FIFOs cannot occupy a worker thread.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit)
        throw new BadRequestException('This room file is not a regular file within the upload limit.');
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes <= limit) {
        const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - bytes));
        const read = await handle.read(chunk, 0, chunk.length, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        chunks.push(chunk.subarray(0, read.bytesRead));
      }
      if (bytes > limit) throw new BadRequestException('This room file exceeds the upload limit.');
      return Buffer.concat(chunks, bytes);
    } finally {
      await handle.close();
    }
  }
  private async validate(target: string, roomId: string, initialProject = false): Promise<string> {
    if (!isAbsolute(target)) throw new BadRequestException('Choose an absolute folder on this room host.');
    if (target.length > 32768 || /[\r\n*?[\]{}\0]/.test(target))
      throw new BadRequestException('This folder path is not supported by the sandbox.');
    let missing = false;
    const canonical = await realpath(target).catch((error: NodeJS.ErrnoException) => {
      // Existing rooms already carry an owner-selected project path. Keep an unavailable
      // attachment visible when that disk is offline, without granting it to the sandbox.
      if (initialProject && error.code === 'ENOENT') {
        missing = true;
        return resolve(target);
      }
      throw new BadRequestException('This folder does not exist on the room host.');
    });
    if (/[\r\n*?[\]{}]/.test(canonical))
      throw new BadRequestException('This canonical folder path is not supported by the sandbox.');
    if (!missing && !(await stat(canonical)).isDirectory()) throw new BadRequestException('Choose a folder.');
    const home = await realpath(homedir());
    const data = await realpath(this.config.dataDir);
    const workspace = await realpath(this.path(roomId));
    const managedProject =
      initialProject && ['scratch', 'worktrees'].some((name) => contains(join(data, name), canonical));
    const credentialPath = managedProject ? relative(data, canonical) : canonical;
    if (
      contains(canonical, home) ||
      (contains(data, canonical) && !managedProject) ||
      contains(canonical, data) ||
      contains(canonical, workspace) ||
      credentialPath.split(sep).some((part) => /^(?:\.(?:ssh|aws|azure|config|pi|gnupg)|Library)$/.test(part))
    )
      throw new BadRequestException(
        'Choose a specific content folder outside application data and credential directories.',
      );
    return canonical;
  }
  private async idle(roomId: string): Promise<void> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new BadRequestException('No room with this id.');
    if (found.leadQuestions.length || this.live.snapshot(roomId).length)
      throw new ConflictException('Wait for the room agents to finish before changing folder access.');
  }
  private async reset(roomId: string): Promise<void> {
    for (const id of await this.store.threads(roomId)) {
      this.preparedRoots.delete(id);
      this.sessions.dispose(id);
      await this.protection.release(`thread:${id}`);
    }
  }
}
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
