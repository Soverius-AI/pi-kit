// Assembles what electron-builder packs.
//
//   node scripts/package-stage.mjs [--target darwin-arm64 --target win32-x64 ...] [--platform darwin|linux|win32 --arch arm64|x64]
//                                  [--skip-build] [--build-only] [--natives-cache <dir>]
//
// dist/package/                the shell, the same for every target
//   package.json               name, version, main -> desktop/main.cjs (no dependencies: the shell bundles everything)
//   desktop/{main,preload}.cjs Electron main process and preload (esbuild bundles, `electron` external)
//   renderer/browser/          the Angular production build, served from app://pi-kit/
// dist/stage/<platform>-<arch>/backend/   one per target
//   main.js + migrations/ + packages/ + assets/: Nx production artifacts, including
//   the bundled Pi SDK, workers, WASM and themes. The only node_modules are the
//   esbuild-built native loaders and target-specific binaries. No dependency tree
//   is copied from the workspace. Electron executes the backend outside app.asar.
// dist/stage/<platform>-<arch>/natives.json   the natives table of that target (module, file, where the binary came from)
import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TRIPLES, dirSize, provisionNatives, tripleOf, verifyStaged } from './natives.mjs';
import runtime from './backend-runtime.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true },
    platform: { type: 'string' },
    arch: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'build-only': { type: 'boolean', default: false },
    'natives-cache': { type: 'string' },
  },
});
const triples = values.target?.length ? values.target : [tripleOf(values.platform ?? process.platform, values.arch ?? process.arch)];
for (const triple of triples) if (!TRIPLES[triple]) throw new Error(`Unknown target ${triple}. Known: ${Object.keys(TRIPLES).join(', ')}`);
const dist = join(root, 'dist');
const stage = join(dist, 'package');
const stageRoot = join(dist, 'stage');
const nativesCache = resolve(values['natives-cache'] ?? process.env.PI_KIT_NATIVES_CACHE ?? join(dist, 'natives-cache'));
const rootModules = join(root, 'node_modules');
const require = createRequire(import.meta.url);

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

if (!values['skip-build']) {
  const started = Date.now();
  run(process.execPath, [join(rootModules, 'nx', 'dist', 'bin', 'nx.js'), 'run-many', '-t', 'build', '-p', 'renderer,backend,desktop,secret-cli', '--configuration=production', '--skip-nx-cache']);
  console.log(`built renderer, backend, desktop and secret-cli in ${seconds(started)}`);
}
if (values['build-only']) process.exit(0);

// ---- the shell
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
mkdirSync(join(stage, 'desktop'));
for (const file of ['main.cjs', 'preload.cjs', 'screenshot-encoder-preload.cjs', 'splash.html', 'icon.png']) cpSync(join(dist, 'apps/desktop', file), join(stage, 'desktop', file));
cpSync(join(dist, 'apps/renderer/browser'), join(stage, 'renderer/browser'), { recursive: true });
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'pi-kit',
      productName: 'pi-kit',
      version: rootPackage.version,
      description: rootPackage.description ?? 'A desktop UI for the pi coding agent',
      author: 'pi-kit',
      license: rootPackage.license,
      main: 'desktop/main.cjs',
    },
    null,
    2,
  ),
);

// ---- the backend: production build artifacts only, followed by target-native selection
const baseRoot = join(stageRoot, '_base');
rmSync(baseRoot, { recursive: true, force: true });
const backendOut = join(baseRoot, 'backend');
mkdirSync(backendOut, { recursive: true });
cpSync(join(dist, 'apps/backend/main.js'), join(backendOut, 'main.js'));
cpSync(join(dist, 'apps/backend/migrations'), join(backendOut, 'migrations'), { recursive: true });
cpSync(join(dist, 'apps/backend/assets'), join(backendOut, 'assets'), { recursive: true });
// The pi packages that ship with the app: @pi-kit/learn, @pi-kit/meat-proxy and @pi-kit/computer-use. The backend adds them to the user's pi settings the first
// time it starts (`pi list` shows them, `pi remove` takes one away).
cpSync(join(dist, 'apps/backend/packages'), join(backendOut, 'packages'), { recursive: true });

// Nx's generated package.json describes the source project graph, including
// packages already bundled. The esbuild output graph is the runtime authority.
const meta = JSON.parse(readFileSync(join(dist, 'apps/backend/meta.json'), 'utf8'));
const main = Object.values(meta.outputs).find((output) => output.entryPoint === 'apps/backend/src/main.ts');
if (!main) throw new Error('No backend main entry in esbuild metadata; build the backend before staging.');
const external = main.imports.filter((entry) => entry.external && !isBuiltin(entry.path)).map((entry) => entry.path);
const isPackage = (specifier, name) => specifier === name || specifier.startsWith(`${name}/`);
const required = external.filter((specifier) => !runtime.optionalImports.some((name) => isPackage(specifier, name)));
for (const specifier of required) {
  if (![...runtime.nativePackages, ...runtime.optionalNativePackages].some((name) => isPackage(specifier, name))) throw new Error(`Unexpected runtime import ${specifier}: bundle its JavaScript or explicitly document why it must stay external.`);
}
// Core JavaScript comes from Nx/esbuild outputs. The self-contained keychain-store
// vendor loader is provisioned with its native prebuild; no JavaScript dependency closure is copied.
cpSync(join(dist, 'apps/backend-runtime/assets'), join(backendOut, 'assets'), { recursive: true });
cpSync(join(dist, 'apps/backend-runtime-natives/node_modules'), join(backendOut, 'node_modules'), { recursive: true });
for (const name of runtime.nativePackages) {
  if (!existsSync(join(backendOut, 'node_modules', name, 'package.json'))) throw new Error(`Missing built native loader ${name}; run backend-runtime:build.`);
}

// `pi-kit-secret`: the CLI bundle sits next to the backend, where the launcher the backend writes looks for it. It loads @napi-rs/keyring from the backend's node_modules.
cpSync(join(dist, 'apps/secret-cli/pi-kit-secret.cjs'), join(backendOut, 'pi-kit-secret.cjs'));

// ---- one backend per target: the base plus that triple's natives
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const electron = require('electron'); // the path of the binary this workspace runs; the host target is loaded in it
for (const triple of triples) {
  const started = Date.now();
  console.log(`\n== ${triple}`);
  const targetRoot = join(stageRoot, triple);
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  const backend = join(targetRoot, 'backend');
  cpSync(backendOut, backend, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const rows = await provisionNatives({ modulesOut: join(backend, 'node_modules'), triple, cacheDir: nativesCache });
  verifyStaged({ backend, triple, electron });
  writeFileSync(join(targetRoot, 'natives.json'), JSON.stringify(rows, null, 2));
  console.log(`staged ${triple}: backend ${mb(dirSize(backend))} (node_modules ${mb(dirSize(join(backend, 'node_modules')))}) in ${seconds(started)}`);
  for (const row of rows) console.log(`  ${row.module.padEnd(32)} ${row.file}\n    <- ${row.source}`);
}
rmSync(baseRoot, { recursive: true, force: true });
console.log(`\nshell ${mb(dirSize(join(stage, 'desktop')) + dirSize(join(stage, 'renderer')))} in ${relative(root, stage)}; backends in ${relative(root, stageRoot)}/<triple>/backend`);
