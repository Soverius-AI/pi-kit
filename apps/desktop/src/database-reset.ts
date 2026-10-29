import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The backend's `DB_FILE` and `BG_DB_FILE`. */
const DATABASES = ['pi-kit.sqlite', 'bg-agents.sqlite'];

/** Deletes the databases and their sidecars; returns the removed names. Encryption transition files are left alone. */
export function removeDatabases(dataDir: string): string[] {
  const removed: string[] = [];
  for (const database of DATABASES) {
    for (const name of [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) {
      const path = join(dataDir, name);
      if (!existsSync(path)) continue;
      rmSync(path, { force: true });
      removed.push(name);
    }
  }
  return removed;
}
