import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FilesService } from './files.service';
import { workspaceMutation } from './safe-path';

/**
 * The file operations of the Files panel's context menu: new file, new folder, rename and delete inside
 * a workspace folder. Every path goes through `workspaceMutation` (relative, contained, no root or Git metadata),
 * and a delete needs the renderer's `confirm: true` after its dialog. Nothing here overwrites: an existing target is a conflict.
 */
@Injectable()
export class FsService {
  constructor(private readonly files: FilesService) {}

  create(cwd: string, path: string, dir: boolean): { path: string } {
    const { path: rel, absolute } = workspaceMutation(cwd, path);
    if (existsSync(absolute)) throw new ConflictException(`${rel} exists already.`);
    // A parent that is a file would make the folder impossible; mkdir says so itself.
    try {
      if (dir) mkdirSync(absolute, { recursive: true });
      else {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, '', { flag: 'wx' });
      }
    } catch (error) {
      throw new ConflictException(`${rel} could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.files.refresh(cwd);
    return { path: rel };
  }

  rename(cwd: string, from: string, to: string): { path: string } {
    const { path: source, absolute: sourceAbsolute } = workspaceMutation(cwd, from);
    const { path: target, absolute: targetAbsolute } = workspaceMutation(cwd, to);
    if (!existsSync(sourceAbsolute)) throw new NotFoundException(`${source} does not exist.`);
    if (existsSync(targetAbsolute)) throw new ConflictException(`${target} exists already.`);
    try {
      mkdirSync(dirname(targetAbsolute), { recursive: true });
      renameSync(sourceAbsolute, targetAbsolute);
    } catch (error) {
      throw new ConflictException(`${source} could not be renamed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.files.refresh(cwd);
    return { path: target };
  }

  /** Removes a file or a folder with everything in it. */
  delete(cwd: string, path: string): void {
    const { path: rel, absolute } = workspaceMutation(cwd, path);
    if (!existsSync(absolute)) throw new NotFoundException(`${rel} does not exist.`);
    const dir = statSync(absolute).isDirectory();
    rmSync(absolute, { recursive: dir, force: true });
    this.files.refresh(cwd);
  }
}
