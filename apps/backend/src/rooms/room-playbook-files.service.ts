import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { PlaybookConfigSchema, type PlaybookConfig, type PlaybookSummary } from '@pi-kit/protocol';
import { RoomFolders } from './room-folders';
import { RoomSchedule } from './room-schedule';

type Read = Playbook | { name: string; description: string; error: string };

export interface PlaybookSource {
  skill: string;
  yaml: string;
}

export interface PlaybookPlace {
  project: string;
  room?: string;
}

export interface Playbook {
  name: string;
  description: string;
  path: string;
  instructions: string;
  config: PlaybookConfig;
}

@Injectable()
export class RoomPlaybookFiles {
  static readonly FOLDERS = [join('.pi', 'skills'), join('.agents', 'skills')];
  static readonly CONFIG = 'room.yaml';
  static readonly SKILL = 'SKILL.md';

  private readonly cache = new Map<string, { stamp: string; read: Read | undefined }>();

  constructor(@Optional() private readonly folders?: RoomFolders) {}

  place(project: string, roomId?: string): PlaybookPlace {
    const room = roomId ? this.roomFolder(roomId) : undefined;
    return room ? { project, room } : { project };
  }

  roomFolder(roomId: string): string | undefined {
    return this.folders?.ensure(roomId);
  }

  origin(place: PlaybookPlace, path: string): 'room' | 'repository' {
    return place.room && path.startsWith(place.room + sep) ? 'room' : 'repository';
  }

  shown(place: PlaybookPlace, dir: string): string {
    return relative(place.room && this.origin(place, dir) === 'room' ? place.room : place.project, dir);
  }

  list(place: PlaybookPlace): PlaybookSummary[] {
    const seen = new Set<string>();
    return this.files(place).flatMap((path): PlaybookSummary[] => {
      const read = this.read(path);
      if (!read || seen.has(read.name)) return [];
      seen.add(read.name);
      const config = 'config' in read ? read.config : undefined;
      return [
        {
          name: read.name,
          description: read.description,
          path,
          origin: this.origin(place, path),
          roles: config?.participants.map((participant) => participant.role) ?? [],
          tools: Object.keys(config?.tools ?? {}),
          outputs: Object.keys(config?.['safe-outputs'] ?? {}),
          triggers: config ? config.on.schedule.length + config.on.poll.length : 0,
          stages: config?.stages ?? [],
          error: 'error' in read ? read.error : null,
        },
      ];
    });
  }

  /** `load` for a route: a playbook that does not parse is the owner's conflict to fix. */
  loadOrConflict(place: PlaybookPlace, name: string): Playbook {
    try {
      return this.load(place, name);
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
  }

  load(place: PlaybookPlace, name: string): Playbook {
    const direct = this.roots(place).map((root) => join(root, name, RoomPlaybookFiles.SKILL));
    for (const path of [...direct.filter((candidate) => this.isPlaybook(candidate)), ...this.files(place)]) {
      const read = this.read(path);
      if (!read || read.name !== name) continue;
      if ('error' in read) throw new Error(`The playbook ${name} is not valid: ${read.error}`);
      return read;
    }
    throw new Error(`No playbook named ${name} in ${place.room ? `${place.room} or ` : ''}${place.project}.`);
  }

  /** Where the playbook `name` lives, with its files' text, or where a new one would go: the room's folder when it has one. */
  locate(place: PlaybookPlace, name: string): { dir: string; source: PlaybookSource | undefined } {
    const path =
      this.files(place).find((candidate) => this.read(candidate)?.name === name) ??
      join(this.roots(place)[0] as string, name, RoomPlaybookFiles.SKILL);
    const dir = dirname(path);
    if (!this.isPlaybook(path)) return { dir, source: undefined };
    return {
      dir,
      source: {
        skill: readFileSync(path, 'utf8'),
        yaml: readFileSync(join(dir, RoomPlaybookFiles.CONFIG), 'utf8'),
      },
    };
  }

  /** Reads proposed files the way `load` reads files on disk; the front matter must name the playbook `name`. */
  validate(path: string, name: string, source: PlaybookSource): Read {
    const read = this.parseText(path, source.skill, () => source.yaml);
    if (read.name !== name)
      return { ...read, error: `The front matter of SKILL.md must say name: ${name} (it says ${read.name}).` };
    return read;
  }

  private roots(place: PlaybookPlace): string[] {
    return [
      ...(place.room ? [join(place.room, RoomFolders.PLAYBOOKS)] : []),
      ...RoomPlaybookFiles.FOLDERS.map((folder) => join(place.project, folder)),
    ];
  }

  private files(place: PlaybookPlace): string[] {
    return this.roots(place).flatMap((root) => {
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .map((entry) => join(root, entry, RoomPlaybookFiles.SKILL))
        .filter((path) => this.isPlaybook(path));
    });
  }

  private isPlaybook(path: string): boolean {
    return existsSync(path) && statSync(path).isFile() && existsSync(join(dirname(path), RoomPlaybookFiles.CONFIG));
  }

  private read(path: string): Read | undefined {
    const config = join(dirname(path), RoomPlaybookFiles.CONFIG);
    const stamp = [path, config]
      .map((file) => statSync(file, { throwIfNoEntry: false }))
      .map((stat) => (stat ? `${stat.mtimeMs}:${stat.size}` : '-'))
      .join('|');
    const kept = this.cache.get(path);
    if (kept?.stamp === stamp) return kept.read;
    const read = this.parse(path);
    this.cache.set(path, { stamp, read });
    return read;
  }

  private parse(path: string): Read {
    return this.parseText(path, readFileSync(path, 'utf8'), () =>
      readFileSync(join(dirname(path), RoomPlaybookFiles.CONFIG), 'utf8'),
    );
  }

  private parseText(path: string, skill: string, yaml: () => string): Read {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(skill);
    let front: unknown;
    try {
      front = match ? parse(match[1] ?? '') : {};
    } catch {
      front = {};
    }
    const record = (front && typeof front === 'object' ? front : {}) as { name?: unknown; description?: unknown };
    const name = typeof record.name === 'string' ? record.name : (path.split(/[\\/]/).at(-2) ?? 'playbook');
    const description = typeof record.description === 'string' ? record.description : '';
    const fail = (error: string) => ({ name, description, error });
    let room: unknown;
    try {
      room = parse(yaml()) ?? {};
    } catch (error) {
      return fail(`room.yaml: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = PlaybookConfigSchema.safeParse(room);
    if (!parsed.success)
      return fail(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || 'room.yaml'}: ${issue.message}`).join('; '),
      );
    const config = parsed.data;
    const twice = Object.keys(config.tools).find((tool) => tool in config['safe-outputs']);
    if (twice) return fail(`${twice} is both a tool and a safe output.`);
    const cron = config.on.schedule.find((schedule) => schedule.cron && !RoomSchedule.valid(schedule.cron));
    if (cron) return fail(`on.schedule ${cron.id} has a cron that is not valid.`);
    const poll = config.on.poll.find((trigger) => !(trigger.tool in config.tools));
    if (poll) return fail(`on.poll ${poll.id} must use one of the tools; safe outputs never run from a trigger.`);
    return { name, description, path, instructions: (match?.[2] ?? '').trim(), config };
  }
}
