import { readFile } from 'node:fs/promises';
import { type PiSessionEntry, aggregateUsage } from '@pi-kit/pi-adapter';
import type { ThreadUsage } from '@pi-kit/protocol';

/**
 * The usage of a thread, read from its pi session file on every request: turns made in the pi CLI after the app opened the
 * session are in the file but not in the open session's memory, and `GET /api/threads/:id/usage` is supposed to count them. A thread
 * without a file yet (no message sent) has no usage.
 */
export async function readThreadUsage(sessionPath: string, fallbackSessionId: string): Promise<ThreadUsage> {
  let text: string;
  try {
    text = await readFile(sessionPath, 'utf8');
  } catch {
    return aggregateUsage([], { sessionId: fallbackSessionId, sessionFile: null });
  }
  let sessionId = fallbackSessionId;
  const entries: PiSessionEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(line) as PiSessionEntry;
    } catch {
      // A half-written last line (pi is appending right now) is not an entry yet.
      continue;
    }
    if (entry.type === 'session') {
      if (typeof entry['id'] === 'string') sessionId = entry['id'];
      continue;
    }
    if (typeof entry.id === 'string') entries.push(entry);
  }
  return aggregateUsage(entries, { sessionId, sessionFile: sessionPath });
}
