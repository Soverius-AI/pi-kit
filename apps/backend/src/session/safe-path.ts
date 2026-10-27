import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { BadRequestException } from '@nestjs/common';

/**
 * A path from the renderer, resolved inside the workspace folder. Relative paths only (`/` separators), no `..` out of
 * the folder, and no symlink that leads out of it: the file panel, the changes view and "open in editor" must never
 * be a way to read, open or delete something elsewhere on the disk.
 */
export function insideWorkspace(cwd: string, relativePath: string): string {
  return resolveWorkspacePath(cwd, relativePath).target;
}

function resolveWorkspacePath(cwd: string, relativePath: string): { root: string; target: string; canonical: string } {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0')) throw new BadRequestException(`${relativePath || 'The path'} is not a path inside the folder.`);
  const root = realpathSync(cwd);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + sep)) throw new BadRequestException(`${relativePath} is outside the folder.`);
  // The nearest part of the path that exists decides where a symlink would lead.
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(root + sep)) throw new BadRequestException(`${relativePath} leads out of the folder.`);
  return { root, target, canonical: resolve(real, relative(probe, target)) };
}

/** Mutations must name an entry, never the workspace itself or Git metadata, including through an alias. */
export function workspaceMutation(cwd: string, path: string): { path: string; absolute: string } {
  const { root, target, canonical } = resolveWorkspacePath(cwd, posixRelative(path));
  const rel = posixRelative(relative(root, target));
  const real = posixRelative(relative(root, canonical));
  if (!rel || !real) throw new BadRequestException('Name a file or folder inside the workspace.');
  if ([rel, real].some((name) => name.split('/').includes('.git'))) throw new BadRequestException('The .git folder is git’s own and is not changed from here.');
  return { path: rel, absolute: target };
}

/** `a\b` or `./a/b` as the `a/b` the git commands and the file index use. */
export function posixRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
