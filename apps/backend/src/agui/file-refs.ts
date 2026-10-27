import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_FILES = 20;
const MAX_BYTES = 256 * 1024;

/**
 * `@file` in the composer: `session.prompt()` does not expand `@path`, so the composer
 * lists the `@paths` of a message in `forwardedProps.fileRefs` and this turns the ones that name text files
 * inside the thread's folder into the `<file name="...">` blocks pi's CLI puts in front of the prompt. Paths
 * that do not exist, lie outside the folder, are binary or too large are left as plain text for the model to
 * read with its own tools.
 */
export function expandFileRefs(cwd: string, refs: readonly string[]): string {
  let out = '';
  const seen = new Set<string>();
  for (const ref of refs.slice(0, MAX_FILES)) {
    const path = resolve(cwd, ref.startsWith('~/') ? ref.replace('~', homedir()) : ref);
    if (seen.has(path) || !isInside(cwd, path)) continue;
    seen.add(path);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_BYTES) continue;
      const buffer = readFileSync(path);
      if (buffer.includes(0)) continue; // binary
      out += `<file name="${path}">\n${buffer.toString('utf8').replace(/^\uFEFF/, '')}\n</file>\n`;
    } catch {
      // Not a readable file: it stays an ordinary word in the message.
    }
  }
  return out;
}

function isInside(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The `fileRefs` of a run's `forwardedProps`, if well-formed. */
export function fileRefsOf(input: { forwardedProps?: unknown }): string[] {
  const refs = (input.forwardedProps as { fileRefs?: unknown } | undefined)?.fileRefs;
  return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === 'string' && r.length < 1024) : [];
}
