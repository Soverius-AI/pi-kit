import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { userMessageText } from '@pi-kit/pi-adapter';

/** What the sidebar needs to know about one session file. Times are epoch milliseconds. */
export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name: string | undefined;
  parentSessionPath: string | undefined;
  created: number;
  modified: number;
  messageCount: number;
  firstMessage: string;
}

interface Cached {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

export interface ScanResult {
  /** Every session file's summary, newest first (pi's order). */
  all: SessionSummary[];
  /** The ones read again in this pass: new files and files whose mtime or size moved. */
  changed: SessionSummary[];
  /** Files looked at / files read. */
  files: number;
  read: number;
}

const STAT_CONCURRENCY = 32;
const READ_CONCURRENCY = 6;

/**
 * An incremental index of pi's session files. `SessionManager.listAll()` opens and parses every file on every call,
 * which for hundreds of sessions of hundreds of kilobytes each is hundreds of megabytes read every 30 seconds. This asks the
 * file system only for `(path, mtime, size)` and reads the files that are new or moved; `summarize` follows pi's own
 * `buildSessionInfo` (same fields, same rules) and a test compares the two on real files.
 */
export class SessionIndex {
  private readonly cache = new Map<string, Cached>();

  private readonly sessionsDir: () => string;

  constructor(sessionsDir: () => string) {
    this.sessionsDir = sessionsDir;
  }

  get size(): number {
    return this.cache.size;
  }

  async scan(): Promise<ScanResult> {
    const dir = this.sessionsDir();
    const paths = await listJsonl(dir);
    const stats = await mapLimit(paths, STAT_CONCURRENCY, async (path) => {
      try {
        const s = await stat(path);
        return { path, mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return undefined;
      }
    });
    const present = stats.filter((s): s is { path: string; mtimeMs: number; size: number } => !!s);
    const stale = present.filter((s) => {
      const known = this.cache.get(s.path);
      return !known || known.mtimeMs !== s.mtimeMs || known.size !== s.size;
    });
    const changed: SessionSummary[] = [];
    await mapLimit(stale, READ_CONCURRENCY, async (s) => {
      const summary = await summarize(s.path, new Date(s.mtimeMs));
      if (!summary) {
        this.cache.delete(s.path);
        return;
      }
      this.cache.set(s.path, { mtimeMs: s.mtimeMs, size: s.size, summary });
      changed.push(summary);
    });
    const seen = new Set(present.map((s) => s.path));
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    const all = [...this.cache.values()].map((c) => c.summary).sort((a, b) => b.modified - a.modified);
    return { all, changed, files: present.length, read: stale.length };
  }
}

async function listJsonl(sessionsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(sessionsDir, e.name));
  const perDir = await mapLimit(dirs, STAT_CONCURRENCY, async (dir) => {
    try {
      return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
    } catch {
      return [];
    }
  });
  return perDir.flat();
}

/** A port of pi's `buildSessionInfo` (session-manager.js), without the full text it builds for pi's own search (and with the first message as typed: `/skill:name` for an expanded skill). */
export async function summarize(path: string, mtime: Date): Promise<SessionSummary | undefined> {
  let header: { id: string; cwd?: unknown; parentSession?: string; timestamp?: string } | undefined;
  let messageCount = 0;
  let firstMessage = '';
  let name: string | undefined;
  let lastActivity: number | undefined;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const entry = parseLine(line);
      if (!entry) continue;
      if (!header) {
        if (entry['type'] !== 'session') return undefined;
        header = entry as unknown as typeof header;
        continue;
      }
      if (entry['type'] === 'session_info') name = (entry['name'] as string | undefined)?.trim() || undefined;
      if (entry['type'] !== 'message') continue;
      messageCount++;
      const message = entry['message'] as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
      if (!message || typeof message.role !== 'string' || !('content' in message)) continue;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const stamp = typeof message.timestamp === 'number' ? message.timestamp : new Date(entry['timestamp'] as string).getTime();
      if (!Number.isNaN(stamp)) lastActivity = Math.max(lastActivity ?? 0, stamp);
      if (!firstMessage && message.role === 'user') {
        // A message that opens with skill instructions (a `/skill:` pi expanded, or chips) reads as the invocations the person made, not as the
        // SKILL.md files; for the title the sentence alone is the name (the chips are drawn beside it), the invocations stay only when there is no sentence.
        const text = titleText(userMessageText(textOf(message.content)));
        if (text) firstMessage = text;
      }
    }
  } catch {
    return undefined;
  }
  if (!header) return undefined;
  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
  const modified = typeof lastActivity === 'number' && lastActivity > 0 ? lastActivity : !Number.isNaN(headerTime) ? headerTime : mtime.getTime();
  return {
    id: header.id,
    path,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    name,
    parentSessionPath: header.parentSession,
    created: new Date(header.timestamp as string).getTime(),
    modified,
    messageCount,
    firstMessage: firstMessage || '(no messages)',
  };
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The name a message gives its thread: the sentence without the leading `/skill:` invocations, unless the invocations are all there is. */
export function titleText(typed: string): string {
  const sentence = typed.replace(/^(?:\/skill:\S+\s*)+/, '').trim();
  return sentence || typed.trim();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => !!block && (block as { type?: unknown }).type === 'text')
    .map((block) => block.text)
    .join(' ');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
