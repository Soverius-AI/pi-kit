import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CreateRoom, PlaybookSummary, Room, RoomClone, RoomStartPreview } from '@pi-kit/protocol';
import { InstanceRepository } from '../db/instance.repository';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { branchOf, changedFiles, run, toplevel } from '../worktree/worktree-git';
import { RepositoryIdentity } from './repository-identity';
import { RoomPlaybookFiles } from './room-playbook-files.service';

export const NO_THREAD = 'No thread with this id.';
export const SEVERAL_CLONES =
  'Several projects here are clones of this repository; choose the folder the room integrates into:';
export const NOT_A_REPOSITORY =
  'A room needs a git repository with at least one commit. Commit in this thread’s folder first.';

@Injectable()
export class RoomsService {
  constructor(
    private readonly rooms: RoomsRepository,
    private readonly threads: ThreadsRepository,
    private readonly instance: InstanceRepository,
    private readonly meta: MetaRepository,
    private readonly playbooks: RoomPlaybookFiles,
  ) {}

  hosted(): Promise<Room[]> {
    return this.rooms.active();
  }

  async preview(threadId: string): Promise<RoomStartPreview> {
    const { root: _root, ...preview } = await this.start(threadId);
    return preview;
  }

  async create(input: CreateRoom, now = Date.now()): Promise<Room> {
    const start = input.threadId ? await this.start(input.threadId) : undefined;
    const repository = start?.repository ?? input.repository ?? '';
    const baseCommit = start?.baseCommit ?? input.baseCommit ?? '';
    const folder = start?.root ?? (await this.chooseClone(repository, baseCommit, input.projectFolder));
    if (!folder)
      throw new ConflictException(
        `No project on this computer is a clone of ${repository} with commit ${baseCommit.slice(0, 7)}. Open one in pi-kit and fetch, then try again.`,
      );
    let stage: string | null = null;
    if (input.playbook) {
      try {
        stage = this.playbooks.load(folder, input.playbook).config.stages[0] ?? null;
      } catch (error) {
        throw new ConflictException(error instanceof Error ? error.message : String(error));
      }
    }
    const room = await this.rooms.insert({
      id: randomUUID(),
      title: input.title,
      repository,
      baseCommit,
      summary: input.summary,
      sourceThreadId: input.threadId ?? null,
      projectFolder: folder,
      playbook: input.playbook ?? null,
      stage,
      createdAt: now,
    });
    if (input.playbook) await this.rooms.setMode(room.id, 'assisted');
    return room;
  }

  async playbooksFor(query: {
    repository: string;
    baseCommit?: string;
    threadId?: string;
  }): Promise<PlaybookSummary[]> {
    const folder = query.threadId
      ? (await this.start(query.threadId)).root
      : query.baseCommit
        ? (await RepositoryIdentity.clones(this.meta, query.repository, query.baseCommit))[0]?.folder
        : undefined;
    return folder ? this.playbooks.list(folder) : [];
  }

  playbooksIn(folder: string): PlaybookSummary[] {
    return this.playbooks.list(folder);
  }

  async clones(repository: string, baseCommit: string): Promise<RoomClone[]> {
    return (await RepositoryIdentity.clones(this.meta, repository, baseCommit)).map(({ folder, clean }) => ({
      folder,
      clean,
    }));
  }

  private async chooseClone(repository: string, baseCommit: string, chosen?: string): Promise<string | undefined> {
    const clones = await RepositoryIdentity.clones(this.meta, repository, baseCommit);
    if (chosen) {
      const match = clones.find((clone) => clone.folder === chosen);
      if (!match)
        throw new ConflictException(
          `${chosen} is not a project here that is a clone of ${repository} with commit ${baseCommit.slice(0, 7)}.`,
        );
      return match.folder;
    }
    if (clones.length > 1)
      throw new ConflictException(`${SEVERAL_CLONES} ${clones.map((clone) => clone.folder).join(', ')}.`);
    return clones[0]?.folder;
  }

  private async start(threadId: string): Promise<RoomStartPreview & { root: string }> {
    const thread = await this.threads.get(threadId);
    if (!thread) throw new NotFoundException(NO_THREAD);
    const folder = thread.worktreePath ?? thread.cwd;
    const root = await toplevel(folder);
    const head = root ? await run(root, ['rev-parse', '--verify', 'HEAD']) : undefined;
    if (!root || !head?.ok) throw new ConflictException(NOT_A_REPOSITORY);
    const identity = await RepositoryIdentity.of(root);
    return {
      title: (thread.title ?? '').slice(0, 200),
      repository: identity?.repository ?? root,
      branch: await branchOf(root),
      baseCommit: head.stdout.trim(),
      uncommittedFiles: (await changedFiles(root)).length,
      root,
    };
  }
}
