// electron-builder `afterPack` hook: puts the staged backend of this target next to app.asar as a plain folder, Resources/backend.
//
// electron-builder's `extraResources` would do it, but it never copies a folder named node_modules, and the backend
// needs its node_modules (the native loaders and binaries of better-sqlite3-multiple-ciphers, @napi-rs/keyring, node-pty and the rest). The hook runs before code signing, so
// every Mach-O file in there (the .node files and node-pty's spawn-helper) is signed with the app.
//
// One electron-builder run can build several architectures (the two Windows ones share one latest.yml), so the backend is picked per
// pack: dist/stage/<platform>-<arch>/backend, staged by scripts/package-stage.mjs with that triple's natives.
const { cpSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Arch } = require('builder-util');
const { installNotarizationRecovery } = require('./mac-notarization.cjs');

exports.default = async function afterPack(context) {
  const triple = `${context.electronPlatformName}-${Arch[context.arch]}`;
  const source = resolve(__dirname, '..', 'dist', 'stage', triple, 'backend');
  if (!existsSync(join(source, 'main.js'))) throw new Error(`The backend for ${triple} is not staged at ${source}; run scripts/package-stage.mjs --target ${triple}.`);
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  cpSync(source, join(resources, 'backend'), { recursive: true, verbatimSymlinks: true });
  console.log(`  • backend (${triple}) copied to ${join(resources, 'backend')}`);
  installNotarizationRecovery(context);
};
