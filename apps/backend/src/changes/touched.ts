import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';

/**
 * "This thread": which files pi touched with `edit` / `write` in a thread, read from the session
 * file's active branch, and how to get back to a file's content from before the first of those calls. Pure; the
 * service adds the disk, git and SQLite.
 */

export interface TouchedStep {
  tool: 'edit' | 'write';
  /** The unified patch pi's `edit` tool reports in `details.patch` (a `write` has none: it replaces the file). */
  patch?: string;
}

export interface TouchedFile {
  /** Relative to the thread's folder, `/` separators. */
  path: string;
  /** The 1-based turn (user message) in which the file was first touched. */
  turn: number;
  steps: TouchedStep[];
}

/** A tool call's `path` argument as a path inside `cwd` (pi accepts `~/`, a leading `@` and absolute paths), or `undefined` if it points elsewhere. */
export function normalizeToolPath(cwd: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let path = raw.trim().replace(/^@/, '');
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

interface PendingCall {
  tool: 'edit' | 'write';
  path: string;
  turn: number;
}

/** Files touched by `edit` / `write` calls that succeeded, in the order they were first touched. */
export function collectTouched(branch: readonly PiSessionEntry[], cwd: string): TouchedFile[] {
  const files = new Map<string, TouchedFile>();
  const calls = new Map<string, PendingCall>();
  let turn = 0;
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = entry['message'] as
      | { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: { patch?: unknown } }
      | undefined;
    if (!message) continue;
    if (message.role === 'user') {
      turn += 1;
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content as {
        type?: string;
        id?: string;
        name?: string;
        arguments?: { path?: unknown };
      }[]) {
        if (block.type !== 'toolCall' || !block.id || (block.name !== 'edit' && block.name !== 'write')) continue;
        const path = normalizeToolPath(cwd, block.arguments?.path);
        if (path) calls.set(block.id, { tool: block.name, path, turn: Math.max(turn, 1) });
      }
    } else if (message.role === 'toolResult' && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (!call || message.isError) continue;
      const patch = typeof message.details?.patch === 'string' ? message.details.patch : undefined;
      const file = files.get(call.path) ?? { path: call.path, turn: call.turn, steps: [] };
      file.steps.push({ tool: call.tool, ...(patch ? { patch } : {}) });
      files.set(call.path, file);
    }
  }
  return [...files.values()];
}
