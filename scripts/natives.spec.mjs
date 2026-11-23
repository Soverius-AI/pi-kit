import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Sharp stages all six target addons and libvips packages and resizes in isolation', async () => {
  const { cpSync } = await import('node:fs');
  // Nx uses tinyglobby to copy assets; use the same matcher to catch lost entry files.
  const { globSync } = await import('tinyglobby');
  const { execFileSync } = await import('node:child_process');
  const { provisionSharp, TRIPLES, readHeader } = await import('./natives.mjs');
  const root = mkdtempSync(join(tmpdir(), 'sharp-stage-'));
  const project = JSON.parse(readFileSync(new URL('../apps/backend-runtime/project.json', import.meta.url), 'utf8'));
  const assets = project.targets['bundle-natives'].options.assets;
  try {
    for (const [triple, target] of Object.entries(TRIPLES)) {
      const modulesOut = join(root, triple, 'node_modules');
      for (const name of ['sharp', '@img/colour', 'detect-libc', 'semver']) {
        const asset = assets.find((entry) => entry.output === name);
        assert.ok(asset, `${name} must be copied by the production build`);
        const source = new URL(`../${asset.input}/`, import.meta.url);
        for (const file of globSync(asset.glob, { cwd: fileURLToPath(source), onlyFiles: true })) {
          const destination = join(modulesOut, asset.output, file);
          mkdirSync(join(destination, '..'), { recursive: true });
          cpSync(new URL(file, source), destination);
        }
      }
      // A previous target must never leak into a new stage.
      mkdirSync(join(modulesOut, '@img/sharp-linuxmusl-x64'), { recursive: true });
      const rows = await provisionSharp({ modulesOut, triple, cacheDir: join(root, 'cache') });
      assert.ok(
        rows.some((row) => row.file.endsWith('.node')),
        triple,
      );
      assert.deepEqual(
        readdirSync(join(modulesOut, '@img'))
          .filter((name) => name.startsWith('sharp-'))
          .sort(),
        [`sharp-${triple}`, ...(target.platform === 'win32' ? [] : [`sharp-libvips-${triple}`])].sort(),
      );
      for (const row of rows) {
        const file = join(modulesOut, row.file);
        const header = readHeader(file);
        assert.equal(header.format, target.format, row.file);
        assert.ok((header.machines ?? [header.machine]).includes(target.machine), row.file);
      }
      if (triple !== `${process.platform}-${process.arch}`) continue;
      const script = join(root, triple, 'smoke.mjs');
      writeFileSync(
        script,
        `
        import assert from 'node:assert/strict';
        import sharp from 'sharp';
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).resize(4, 4).png().toBuffer();
        const metadata = await require('sharp')(png).metadata();
        assert.equal(metadata.width, 4);
        assert.equal(metadata.height, 4);
        assert.equal(metadata.format, 'png');
        console.log('isolated ESM and CJS native image resize ok');
      `,
      );
      assert.match(
        execFileSync(process.execPath, [script], {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, NODE_PATH: '' },
        }),
        /isolated ESM and CJS native image resize ok/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Use the published package rather than mock bytes for the new runtime: this
// catches package-type changes, missing worker entrypoints and loader closure.
test('AppThreat package copy preserves ESM, selects all six targets, and runs asynchronously in isolation', async () => {
  const { cpSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { dirname, resolve } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { provisionAppThreatPrebuild, appThreatBinary, TRIPLES, readHeader } = await import('./natives.mjs');
  const require = createRequire(import.meta.url);
  const root = mkdtempSync(join(tmpdir(), 'appthreat-stage-'));
  try {
    for (const [triple, target] of Object.entries(TRIPLES)) {
      const sqlite = join(root, triple, 'node_modules/@appthreat/sqlite3');
      cpSync(dirname(require.resolve('@appthreat/sqlite3/package.json')), sqlite, { recursive: true });
      const row = await provisionAppThreatPrebuild({ sqlite, triple, cacheDir: join(root, 'cache') });
      assert.equal(row.file, appThreatBinary(triple));
      assert.deepEqual(readdirSync(join(sqlite, 'prebuilds')), [triple]);
      assert.deepEqual(readdirSync(join(sqlite, 'prebuilds', triple)), [row.file.split('/').pop()]);
      const header = readHeader(join(sqlite, row.file));
      assert.equal(header.format, target.format);
      assert.ok((header.machines ?? [header.machine]).includes(target.machine));
      const bytes = readFileSync(join(sqlite, row.file));
      assert.ok(bytes.includes('napi_'));
      assert.ok(!bytes.includes('node_module_register') && !bytes.includes('_ZN2v8'));
      assert.equal(JSON.parse(readFileSync(join(sqlite, 'package.json'))).type, 'module');
      for (const file of ['sqlite3.js', 'pool.js', 'worker.js']) assert.ok(existsSync(join(sqlite, 'lib', file)));
      if (triple !== `${process.platform}-${process.arch}`) continue;
      const modules = resolve(sqlite, '../..');
      for (const name of ['node-gyp-build', 'node-addon-api'])
        cpSync(dirname(require.resolve(`${name}/package.json`)), join(modules, name), { recursive: true });
      const script = join(root, triple, 'smoke.mjs');
      writeFileSync(
        script,
        `
        import assert from 'node:assert/strict';
        import sqlite3 from '@appthreat/sqlite3';
        const memory = await sqlite3.open(':memory:');
        await memory.exec('CREATE TABLE smoke (value INTEGER)');
        await memory.transaction(async tx => { await tx.run('INSERT INTO smoke VALUES (?)', [42]); });
        assert.equal((await memory.get('SELECT value FROM smoke')).value, 42);
        await assert.rejects(memory.transaction(async tx => {
          await tx.run('INSERT INTO smoke VALUES (99)'); throw new Error('rollback');
        }), /rollback/);
        assert.equal((await memory.get('SELECT count(*) n FROM smoke')).n, 1);
        await memory.close();
        const a = await sqlite3.open(${JSON.stringify(join(root, 'lock.sqlite'))});
        const b = await sqlite3.open(${JSON.stringify(join(root, 'lock.sqlite'))});
        try {
          await a.exec('CREATE TABLE locks (value); BEGIN IMMEDIATE');
          await b.exec('PRAGMA busy_timeout=300');
          let ticks = 0;
          const timer = setInterval(() => ticks++, 10);
          try { await assert.rejects(b.run('INSERT INTO locks VALUES (1)'), /SQLITE_BUSY|locked/); }
          finally { clearInterval(timer); }
          assert.ok(ticks >= 5, 'lock wait blocked the event loop: ' + ticks);
          await a.exec('ROLLBACK');
        } finally { await a.close(); await b.close(); }
        console.log('isolated ESM async query, transaction, rollback and responsive lock wait ok');
      `,
      );
      const output = execFileSync(process.execPath, [script], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, NODE_PATH: '' },
      });
      assert.match(output, /responsive lock wait ok/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AppThreat recovers missing target from pinned tarball cache and prunes musl and foreign targets', async () => {
  const { provisionAppThreatPrebuild } = await import('./natives.mjs');
  const root = mkdtempSync(join(tmpdir(), 'appthreat-recovery-'));
  try {
    const sqlite = join(root, 'stage');
    const cacheDir = join(root, 'cache');
    const pristine = join(cacheDir, 'appthreat__sqlite3-0.0.0-test/package');
    for (const dir of [sqlite, pristine]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
    }
    mkdirSync(join(pristine, 'prebuilds/linux-x64'), { recursive: true });
    writeFileSync(join(pristine, 'prebuilds/linux-x64/@appthreat+sqlite3.glibc.node'), 'glibc');
    mkdirSync(join(sqlite, 'prebuilds/linux-x64'), { recursive: true });
    mkdirSync(join(sqlite, 'prebuilds/win32-arm64'), { recursive: true });
    writeFileSync(join(sqlite, 'prebuilds/linux-x64/@appthreat+sqlite3.musl.node'), 'musl');
    await provisionAppThreatPrebuild({ sqlite, triple: 'linux-x64', cacheDir });
    assert.deepEqual(readdirSync(join(sqlite, 'prebuilds')), ['linux-x64']);
    assert.deepEqual(readdirSync(join(sqlite, 'prebuilds/linux-x64')), ['@appthreat+sqlite3.glibc.node']);
    await assert.rejects(
      provisionAppThreatPrebuild({ sqlite, triple: 'win32-arm64', cacheDir }),
      /No @appthreat\/sqlite3 binary for win32-arm64/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
