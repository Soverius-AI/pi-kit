import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { removeDatabases } from './database-reset';

it('removes both databases and their sidecars, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-db-reset-'));
  try {
    for (const name of ['pi-kit.sqlite', 'pi-kit.sqlite-wal', 'pi-kit.sqlite-shm', 'bg-agents.sqlite', 'bg-agents-owner.sqlite', 'pi-kit.sqlite.plaintext', 'ui-storage.json']) {
      writeFileSync(join(dir, name), '');
    }
    expect(removeDatabases(dir)).toEqual(['pi-kit.sqlite', 'pi-kit.sqlite-wal', 'pi-kit.sqlite-shm', 'bg-agents.sqlite']);
    expect(readdirSync(dir).sort()).toEqual(['bg-agents-owner.sqlite', 'pi-kit.sqlite.plaintext', 'ui-storage.json']);
    expect(removeDatabases(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
