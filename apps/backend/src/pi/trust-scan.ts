import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { TrustResource } from '@pi-kit/protocol';

const exists = (path: string): boolean => existsSync(path);
const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
};

/** The number of servers a `mcp.json` defines (`mcpServers`), or `undefined` if it cannot be read. */
export function countMcpServers(file: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers && typeof parsed.mcpServers === 'object' ? Object.keys(parsed.mcpServers).length : 0;
  } catch {
    return undefined;
  }
}

/**
 * What the folder holds that pi gates behind project trust (docs/security.md, "Resources protected by project trust"):
 * `.pi/settings.json`, `.pi/mcp.json`, extensions, skills, prompts and themes under `.pi`, `SYSTEM.md` /
 * `APPEND_SYSTEM.md`, and `.agents/skills` in the folder or an ancestor (`userSkillsDir`, normally `~/.agents/skills`,
 * is the user's own and not listed). It is what the trust dialog shows, so the user sees what would run.
 */
export function scanTrustResources(cwd: string, userSkillsDir?: string): TrustResource[] {
  const out: TrustResource[] = [];
  const pi = join(cwd, '.pi');
  const rel = (path: string): string => relative(cwd, path) || path;

  for (const name of list(join(pi, 'extensions'))) {
    out.push({ kind: 'extension', path: rel(join(pi, 'extensions', name)) });
  }
  const skillsAt = (dir: string): void => {
    for (const name of list(dir)) {
      const path = join(dir, name);
      if (isDir(path)) {
        if (exists(join(path, 'SKILL.md'))) out.push({ kind: 'skill', path: rel(join(path, 'SKILL.md')) });
      } else if (name.endsWith('.md')) {
        out.push({ kind: 'skill', path: rel(path) });
      }
    }
  };
  skillsAt(join(pi, 'skills'));
  for (const name of list(join(pi, 'prompts'))) out.push({ kind: 'prompt', path: rel(join(pi, 'prompts', name)) });
  for (const name of list(join(pi, 'themes'))) out.push({ kind: 'theme', path: rel(join(pi, 'themes', name)) });
  if (exists(join(pi, 'mcp.json'))) {
    const servers = countMcpServers(join(pi, 'mcp.json'));
    out.push({ kind: 'mcp', path: rel(join(pi, 'mcp.json')), ...(servers !== undefined ? { servers } : {}) });
  }
  if (exists(join(pi, 'settings.json'))) out.push({ kind: 'settings', path: rel(join(pi, 'settings.json')) });
  for (const file of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
    if (exists(join(pi, file))) out.push({ kind: 'prompt-file', path: rel(join(pi, file)) });
  }
  // `.agents/skills` here and in every ancestor, but not the user's own.
  for (let dir = cwd; ; dir = dirname(dir)) {
    const agents = join(dir, '.agents', 'skills');
    if (agents !== userSkillsDir && isDir(agents)) skillsAt(agents);
    if (dirname(dir) === dir) break;
  }

  return out;
}

/**
 * A fingerprint of everything in the folder that pi gates behind project trust: the paths (relative to the folder) and contents of the resources
 * `scanTrustResources` finds, directories walked. Two folders with the same fingerprint would load the same project extensions, skills, prompts and
 * `mcp.json`, so a trust answer for one is an answer for the other (a thread's worktree of the project). Every byte counts, read in
 * chunks between turns of the event loop: a vendored dependency under an extension costs time, not the responsiveness of the backend.
 */
export async function trustDigest(cwd: string): Promise<string> {
  const hash = createHash('sha256');
  const directories = new Set<string>();
  const feed = async (path: string): Promise<void> => {
    const info = await stat(path);
    if (info.isDirectory()) {
      const real = await realpath(path);
      if (directories.has(real)) throw new Error(`Project resource directory cycle at ${relative(cwd, path)}.`);
      directories.add(real);
      try {
        // Dependencies may be hidden. The dialog's top-level discovery rules do not limit a resource's contents.
        for (const name of (await readdir(path)).sort()) await feed(join(path, name));
      } finally {
        directories.delete(real);
      }
      return;
    }
    if (!info.isFile()) return;
    hash.update(`${JSON.stringify([relative(cwd, path), info.size])}\0`);
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  };
  for (const resource of scanTrustResources(cwd)) {
    // A skill is its folder; an extension is a file or a folder.
    const path = join(cwd, resource.path);
    await feed(resource.kind === 'skill' && path.endsWith('SKILL.md') ? dirname(path) : path);
  }
  return hash.digest('hex');
}
