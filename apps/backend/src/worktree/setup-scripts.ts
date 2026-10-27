import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import type { SetupScript } from '@pi-kit/protocol';

/** The lockfiles that suggest a setup script, in the order they are looked: the first one the project folder has wins. */
const LOCKFILES: readonly { files: readonly string[]; name: string; command: string }[] = [
  { files: ['pnpm-lock.yaml'], name: 'pnpm', command: 'pnpm install --frozen-lockfile' },
  { files: ['bun.lock', 'bun.lockb'], name: 'bun', command: 'bun install' },
  { files: ['yarn.lock'], name: 'yarn', command: 'yarn install --immutable' },
  { files: ['package-lock.json'], name: 'npm', command: 'npm ci' },
];

/** The default setup script a project's lockfile suggests; `undefined` when the folder has none of the known lockfiles. `has` answers whether a file is in the folder. */
export function detectSetupScript(has: (file: string) => boolean): SetupScript | undefined {
  const found = LOCKFILES.find((entry) => entry.files.some(has));
  return found && { id: found.name, name: found.name, command: found.command };
}

/** `detectSetupScript` for a folder on disk. */
export const detectSetupScriptIn = (folder: string): SetupScript | undefined => detectSetupScript((file) => existsSync(join(folder, file)));

/**
 * The scripts a project has: the ones saved; else the one its lockfile suggests. `saved` is `null` when nothing was ever configured and `[]` when the
 * person chose none. The detected script is not saved until the person saves the list.
 */
export function effectiveScripts(options: { saved: SetupScript[] | null; detect: () => SetupScript | undefined }): SetupScript[] {
  if (options.saved !== null) return options.saved;
  const detected = options.detect();
  return detected ? [detected] : [];
}

/**
 * The script a new worktree runs: `requested` `undefined` is the first one (the default), `null` none, a string the script with that id (or name). An id that is not
 * there is a 400, so a script deleted since the page opened is told rather than silently skipped.
 */
export function pickScript(scripts: readonly SetupScript[], requested: string | null | undefined): SetupScript | undefined {
  if (requested === null) return undefined;
  if (requested === undefined) return scripts[0];
  const found = scripts.find((s) => s.id === requested) ?? scripts.find((s) => s.name === requested);
  if (!found) throw new BadRequestException(`There is no setup script “${requested}” in this project.`);
  return found;
}

/** A path from a script's `copy` list is a file inside the project: relative, no `..`. */
export function safeCopyPath(path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const clean = normalize(path);
  if (clean === '.' || clean === '..' || clean.startsWith(`..${sep}`)) return undefined;
  return clean;
}

/** Copies the script's files from the project into the new worktree; one that is missing or unsafe is skipped (a `.env.local` the project does not have is not an error). Returns what was copied. */
export function copyScriptFiles(script: SetupScript, from: string, to: string): string[] {
  const copied: string[] = [];
  for (const path of script.copy ?? []) {
    const clean = safeCopyPath(path);
    if (!clean) continue;
    const source = join(from, clean);
    try {
      if (!existsSync(source) || !statSync(source).isFile()) continue;
      mkdirSync(dirname(join(to, clean)), { recursive: true });
      copyFileSync(source, join(to, clean));
      copied.push(clean);
    } catch {
      // unreadable: the person sees the file missing in the new folder; setup goes on
    }
  }
  return copied;
}
