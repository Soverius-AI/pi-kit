import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { provisionSqlitePrebuild } from './natives.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-prebuild-'));
  const sqlite = join(root, 'stage');
  const cacheDir = join(root, 'cache');
  const pristine = join(cacheDir, 'better-sqlite3-multiple-ciphers-0.0.0-test', 'package');
  for (const dir of [sqlite, pristine]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  }
  return Promise.resolve()
    .then(() => run({ sqlite, cacheDir, pristine }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test('missing SQLite prebuild folder is recovered for both Windows architectures', () =>
  fixture(async ({ sqlite, cacheDir, pristine }) => {
    mkdirSync(join(pristine, 'prebuilds'));
    for (const arch of ['x64', 'arm64']) writeFileSync(join(pristine, 'prebuilds', `win32-${arch}.node`), arch);
    for (const arch of ['x64', 'arm64']) {
      const triple = `win32-${arch}`;
      const row = await provisionSqlitePrebuild({ sqlite, cacheDir, triple });
      assert.equal(row.file, `prebuilds/${triple}.node`);
      assert.equal(readFileSync(join(sqlite, row.file), 'utf8'), arch);
      assert.deepEqual(readdirSync(join(sqlite, 'prebuilds')), [`${triple}.node`]);
    }
    assert.equal(readdirSync(join(pristine, 'prebuilds')).length, 2, 'cached source must not be pruned');
  }));

test('existing target binary needs no registry lookup and other architectures are pruned', () =>
  fixture(async ({ sqlite, cacheDir }) => {
    mkdirSync(join(sqlite, 'prebuilds'));
    writeFileSync(join(sqlite, 'prebuilds', 'win32-x64.node'), 'existing');
    writeFileSync(join(sqlite, 'prebuilds', 'darwin-arm64.node'), 'other');
    await provisionSqlitePrebuild({ sqlite, cacheDir, triple: 'win32-x64' });
    assert.deepEqual(readdirSync(join(sqlite, 'prebuilds')), ['win32-x64.node']);
  }));

test('a pinned package without the requested SQLite binary still fails', () =>
  fixture(async ({ sqlite, cacheDir }) => {
    await assert.rejects(
      provisionSqlitePrebuild({ sqlite, cacheDir, triple: 'win32-arm64' }),
      /No better-sqlite3-multiple-ciphers binary for win32-arm64/,
    );
    assert.equal(existsSync(join(sqlite, 'prebuilds')), false);
  }));
