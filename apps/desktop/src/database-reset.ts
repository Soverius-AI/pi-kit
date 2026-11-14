import { existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { InstanceKeyStore } from '@pi-kit/service-host';

/** The backend's `DB_FILE` and `BG_DB_FILE`. */
const DATABASES = ['pi-kit.sqlite', 'bg-agents.sqlite'];

/** Deletes the databases, their sidecars and the instance key; returns the removed names. Encryption transition files are left alone. */
export function removeDatabases(dataDir: string): string[] {
  const paths = DATABASES.flatMap((database) =>
    [database, `${database}-wal`, `${database}-shm`, `${database}-journal`].map((name) => join(dataDir, name)),
  );
  const removed: string[] = [];
  for (const path of [...paths, InstanceKeyStore.file(dataDir)]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(relative(dataDir, path));
  }
  return removed;
}
