import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { removeDatabases } from './database-reset';

it('removes both databases, their sidecars and the instance key, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-db-reset-'));
  try {
    for (const name of [
      'pi-kit.sqlite',
      'pi-kit.sqlite-wal',
      'pi-kit.sqlite-shm',
      'bg-agents.sqlite',
      'bg-agents-owner.sqlite',
      'pi-kit.sqlite.plaintext',
      'ui-storage.json',
    ]) {
      writeFileSync(join(dir, name), '');
    }
    mkdirSync(join(dir, 'instance-keys'));
    writeFileSync(join(dir, 'instance-keys', 'identity.v1.enc'), '');
    expect(removeDatabases(dir)).toEqual([
      'pi-kit.sqlite',
      'pi-kit.sqlite-wal',
      'pi-kit.sqlite-shm',
      'bg-agents.sqlite',
      join('instance-keys', 'identity.v1.enc'),
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      'bg-agents-owner.sqlite',
      'instance-keys',
      'pi-kit.sqlite.plaintext',
      'ui-storage.json',
    ]);
    expect(readdirSync(join(dir, 'instance-keys'))).toEqual([]);
    expect(removeDatabases(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
