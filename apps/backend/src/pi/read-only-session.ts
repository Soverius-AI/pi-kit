import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import type { PiModule } from './load-pi';

/**
 * Sidebar/tree reads must not use SessionManager.open(): it uses synchronous filesystem
 * reads and can repair a missing final newline or migrate/rewrite the source file.
 * Keep SDK migration/tree semantics, but only in an in-memory manager after async I/O.
 */
export async function readOnlySession(pi: PiModule, path: string) {
  type Entries = NonNullable<Parameters<PiModule['SessionManager']['inMemory']>[2]>;
  const size = (await stat(path)).size;
  if (size === 0) throw new Error(`Session file is not a valid session: ${path}`);
  const entries: Entries = [];
  let pending = '';
  let budgetStarted = performance.now();
  const parse = (line: string): void => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Match the SDK's loadEntriesFromFile: malformed lines are skipped.
    }
  };
  for await (const chunk of createReadStream(path, { encoding: 'utf8', end: size - 1 })) {
    pending += chunk;
    let start = 0;
    let end: number;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      parse(pending.slice(start, end));
      start = end + 1;
      // Buffered data otherwise runs through promise microtasks without servicing HTTP/timers.
      if (performance.now() - budgetStarted >= 8) {
        await yieldToIo();
        budgetStarted = performance.now();
      }
    }
    pending = pending.slice(start);
  }
  parse(pending);
  const header = entries[0];
  if (!header || header.type !== 'session' || typeof header.id !== 'string')
    throw new Error(`Session file is not a valid session: ${path}`);
  return pi.SessionManager.inMemory(typeof header.cwd === 'string' ? header.cwd : undefined, undefined, entries);
}
