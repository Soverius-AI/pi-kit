// The native modules of a release build, per target triple.
//
// The backend ships five sets of native code. All of them are N-API (ABI-stable across Node and Electron versions), so "the
// binary for Electron 44" is the binary for the target OS and CPU; nothing is compiled and nothing is rebuilt against Electron.
//
//   module                          where the target's binary comes from
//   @napi-rs/keyring                one package per platform (`@napi-rs/keyring-<triple>-msvc` ...): the host's comes with the
//                                   install; the others are downloaded from the registry into a cache and checked against pnpm-lock.yaml's integrity
//   better-sqlite3-multiple-ciphers `prebuilds/<platform>-<arch>.node` inside the package's own tarball (all platforms ship together)
//   node-pty                        `prebuilds/<platform>-<arch>/` inside the package's own tarball (darwin and win32; Linux has none)
//   @earendil-works/pi-tui          `native/<platform>/prebuilds/<platform>-<arch>/` inside the package's own tarball
//   @trycua/cua-driver              computer use (packages/pi-computer-use): one package per platform (`@trycua/cua-driver-<triple>`, the SDK
//                                   library and its N-API runtime; glibc on Linux), fetched like the keyring's
//
// `provisionNatives` puts exactly one triple's binaries into a staged backend `node_modules`; it throws, naming module and triple,
// when one is missing. `verifyStaged` then checks what was staged: file headers (PE machine, Mach-O cputype, ELF machine) for every
// native file, the N-API marker, and, when the target is the machine we run on, a real load in Electron.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The supported release triples. Linux uses native runners because node-pty is built from source. */
export const TRIPLES = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', keyring: 'darwin-arm64', cua: 'darwin-arm64', format: 'macho', machine: 0x0100000c },
  'darwin-x64': { platform: 'darwin', arch: 'x64', keyring: 'darwin-x64', cua: 'darwin-x64', format: 'macho', machine: 0x01000007 },
  'win32-x64': { platform: 'win32', arch: 'x64', keyring: 'win32-x64-msvc', cua: 'win32-x64-msvc', format: 'pe', machine: 0x8664 },
  'win32-arm64': { platform: 'win32', arch: 'arm64', keyring: 'win32-arm64-msvc', cua: 'win32-arm64-msvc', format: 'pe', machine: 0xaa64 },
  'linux-x64': { platform: 'linux', arch: 'x64', keyring: 'linux-x64-gnu', cua: 'linux-x64-gnu', format: 'elf', machine: 0x3e },
  'linux-arm64': { platform: 'linux', arch: 'arm64', keyring: 'linux-arm64-gnu', cua: 'linux-arm64-gnu', format: 'elf', machine: 0xb7 },
};

export function tripleOf(platform, arch) {
  const triple = `${platform}-${arch}`;
  if (!TRIPLES[triple]) throw new Error(`Unsupported target ${triple}. Known: ${Object.keys(TRIPLES).join(', ')}`);
  return triple;
}

export const isHost = (triple) => triple === `${process.platform}-${process.arch}`;

/** The Cua Driver SDK library's file name on each OS. */
const cuaLibrary = (platform) => ({ win32: 'cua_driver_sdk.dll', darwin: 'libcua_driver_sdk.dylib', linux: 'libcua_driver_sdk.so' })[platform];

/** The `integrity` (sha512, base64) pnpm-lock.yaml records for `name@version`, or undefined. */
function lockedIntegrity(name, version) {
  const lock = parseYaml(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  return lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
}

function sri(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

/** Where the install put `name`, as a real path: with `node-linker=hoisted` every package is at the top of node_modules;
 *  the second place is node_modules/.pnpm/node_modules, where pnpm's default (isolated) linker keeps what it hoists. */
function installedDir(name) {
  for (const dir of [join(root, 'node_modules', name), join(root, 'node_modules', '.pnpm', 'node_modules', name)]) {
    if (existsSync(join(dir, 'package.json'))) return realpathSync(dir);
  }
  return undefined;
}

/**
 * The directory of `name@version`: the workspace's own node_modules when the install put it there, else the tarball fetched with
 * registry tarball downloaded into `cacheDir` (`pnpm pack` only packs the local project, so the tarball is fetched directly), verified
 * against pnpm-lock.yaml's integrity and unpacked once.
 * @returns {Promise<{ dir: string, source: string }>}
 */
async function packageDir(name, version, cacheDir, log) {
  const installed = installedDir(name);
  if (installed && JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version === version) {
    return { dir: installed, source: `installed (${relative(root, installed)}), ${name}@${version}` };
  }
  const slug = `${name.replace(/^@/, '').replace('/', '__')}-${version}`;
  const unpacked = join(cacheDir, slug, 'package');
  if (existsSync(join(unpacked, 'package.json'))) return { dir: unpacked, source: `registry tarball ${name}@${version} (cached in ${relative(root, cacheDir) || cacheDir})` };
  const integrity = lockedIntegrity(name, version);
  if (!integrity) throw new Error(`pnpm-lock.yaml has no entry for ${name}@${version}; refusing to fetch an unpinned binary. Run pnpm install.`);
  const work = mkdtempSync(join(tmpdir(), 'pi-kit-pack-'));
  try {
    log(`  fetching ${name}@${version} (registry tarball)`);
    const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/');
    const url = `${registry}${name}/-/${name.split('/').pop()}-${version}.tgz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sri(bytes);
    if (actual !== integrity) throw new Error(`${name}@${version}: the downloaded tarball is ${actual}, pnpm-lock.yaml says ${integrity}`);
    const tarball = join(work, 'package.tgz');
    writeFileSync(tarball, bytes);
    rmSync(join(cacheDir, slug), { recursive: true, force: true });
    mkdirSync(join(cacheDir, slug), { recursive: true });
    // Windows: the system's bsdtar by its full path (a GNU tar earlier on PATH, as in a bash step on a CI runner, reads "C:\..." as host:file).
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', tarball, '-C', join(cacheDir, slug)], { stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!existsSync(join(unpacked, 'package.json'))) throw new Error(`${name}@${version}: the tarball has no package/ folder`);
  return { dir: unpacked, source: `registry tarball ${name}@${version}, integrity checked against pnpm-lock.yaml` };
}

/**
 * Selects one target's binaries from the Nx runtime assets and provisions its keyring binary.
 * @returns {{ module: string, file: string, source: string }[]} one row per native file, for the report
 */
export async function provisionNatives({ modulesOut, triple, cacheDir, log = console.log }) {
  const t = TRIPLES[triple];
  const rows = [];
  const fail = (module, why) => {
    throw new Error(`No ${module} binary for ${triple}: ${why}`);
  };
  const prune = (path) => rmSync(join(modulesOut, path), { recursive: true, force: true });

  // ---- @napi-rs/keyring: one optional package per platform
  const keyringManifest = JSON.parse(readFileSync(join(modulesOut, '@napi-rs', 'keyring', 'package.json'), 'utf8'));
  const keyringName = `@napi-rs/keyring-${t.keyring}`;
  const keyringVersion = keyringManifest.optionalDependencies?.[keyringName];
  if (!keyringVersion) fail('@napi-rs/keyring', `${keyringName} is not among its optionalDependencies (${Object.keys(keyringManifest.optionalDependencies ?? {}).join(', ')})`);
  let keyring;
  try {
    keyring = await packageDir(keyringName, keyringVersion, cacheDir, log);
  } catch (error) {
    fail('@napi-rs/keyring', `${keyringName}@${keyringVersion} could not be fetched (${error.message})`);
  }
  for (const entry of existsSync(join(modulesOut, '@napi-rs')) ? readdirSync(join(modulesOut, '@napi-rs')) : []) {
    if (entry.startsWith('keyring-')) prune(`@napi-rs/${entry}`);
  }
  cpSync(keyring.dir, join(modulesOut, keyringName), { recursive: true });
  const keyringNode = readdirSync(join(modulesOut, keyringName)).find((f) => f.endsWith('.node'));
  if (!keyringNode) fail('@napi-rs/keyring', `${keyringName}@${keyringVersion} contains no .node file`);
  rows.push({ module: '@napi-rs/keyring', file: `${keyringName}/${keyringNode}`, source: keyring.source });

  // ---- keychain-store: self-contained JS loader plus one Swift N-API prebuild (macOS only).
  prune('keychain-store');
  if (t.platform === 'darwin') {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).optionalDependencies['keychain-store'];
    const keychain = await packageDir('keychain-store', version, cacheDir, log);
    const destination = join(modulesOut, 'keychain-store');
    cpSync(keychain.dir, destination, { recursive: true });
    const wanted = `keychain_store.darwin-${t.arch}.node`;
    for (const file of readdirSync(join(destination, 'dist'))) {
      if (file.endsWith('.node') && file !== wanted) rmSync(join(destination, 'dist', file));
    }
    if (!existsSync(join(destination, 'dist', wanted))) fail('keychain-store', `missing dist/${wanted}`);
    rows.push({ module: 'keychain-store', file: `dist/${wanted}`, source: keychain.source });
  }

  // ---- better-sqlite3-multiple-ciphers: N-API prebuilds named <platform>-<arch>.node, the SQLite3 Multiple Ciphers sources next to them
  const sqlite = join(modulesOut, 'better-sqlite3-multiple-ciphers');
  if (existsSync(sqlite)) {
    for (const path of ['deps', 'src', 'binding.gyp', 'build']) prune(`better-sqlite3-multiple-ciphers/${path}`);
    const prebuilds = join(sqlite, 'prebuilds');
    const wanted = `${triple}.node`;
    if (!existsSync(join(prebuilds, wanted))) fail('better-sqlite3-multiple-ciphers', `prebuilds/${wanted} is not in the package (it ships: ${existsSync(prebuilds) ? readdirSync(prebuilds).join(', ') : 'no prebuilds folder'})`);
    for (const file of readdirSync(prebuilds)) if (file !== wanted) rmSync(join(prebuilds, file));
    const version = JSON.parse(readFileSync(join(sqlite, 'package.json'), 'utf8')).version;
    rows.push({ module: 'better-sqlite3-multiple-ciphers', file: `prebuilds/${wanted}`, source: `prebuilds/ in the npm tarball, ${version} (N-API)` });
  }

  // ---- node-pty: prebuilds/<platform>-<arch>/ in the tarball. Linux has none: a host-built build/Release is accepted there and nowhere else.
  const pty = join(modulesOut, 'node-pty');
  if (existsSync(pty)) {
    const version = JSON.parse(readFileSync(join(pty, 'package.json'), 'utf8')).version;
    const prebuilds = join(pty, 'prebuilds');
    const mine = join(prebuilds, triple);
    if (existsSync(mine)) {
      // The loader tries build/Release before prebuilds. Never leave a host build ahead of the selected target.
      prune('node-pty/build');
      for (const entry of readdirSync(prebuilds)) if (entry !== triple) rmSync(join(prebuilds, entry), { recursive: true });
      // Debug symbols of the Windows binaries are 20+ MB per architecture and nothing loads them.
      (function dropSymbols(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) dropSymbols(join(dir, entry.name));
          else if (entry.name.endsWith('.pdb')) rmSync(join(dir, entry.name));
        }
      })(mine);
      for (const dir of ['deps', 'src', 'third_party', 'scripts']) prune(`node-pty/${dir}`);
      prune('node-pty/binding.gyp');
      // The helper that forks the pty must be executable (TerminalService repeats this at run time for dev installs, scripts/postinstall.mjs at install).
      if (t.platform === 'darwin') {
        const helper = join(mine, 'spawn-helper');
        if (!existsSync(helper)) fail('node-pty', `prebuilds/${triple}/spawn-helper is missing`);
        chmodSync(helper, 0o755);
      }
      for (const file of readdirSync(mine)) if (file.endsWith('.node')) rows.push({ module: 'node-pty', file: `prebuilds/${triple}/${file}`, source: `prebuilds/${triple}/ in the npm tarball, ${version} (N-API)` });
    } else if (isHost(triple) && existsSync(join(pty, 'build', 'Release', 'pty.node'))) {
      // The npm tarball also contains macOS and Windows binaries. A Linux source build must not ship them.
      prune('node-pty/prebuilds');
      rows.push({ module: 'node-pty', file: 'build/Release/pty.node', source: `compiled on this machine (node-gyp), ${version}` });
    } else {
      fail('node-pty', `prebuilds/${triple}/ is not in the package (it ships: ${existsSync(prebuilds) ? readdirSync(prebuilds).join(', ') : 'no prebuilds folder'}); ${t.platform === 'linux' ? 'run node-gyp rebuild in node_modules/node-pty on a Linux host first' : 'there is nothing to fetch'}`);
    }
  }

  // ---- @trycua/cua-driver (computer use): its ESM JavaScript, its two JavaScript dependencies, and the one platform package with `<lib>cua_driver_sdk.<dylib|dll|so>` and
  //      `cua_driver_node_runtime.node`. `@ubjs/node` is used only for its resolve-lib.js, so its own per-platform binaries are not shipped. The Linux library links
  //      libX11, libXi, libxkbcommon and libxcb, which any desktop session has.
  for (const name of ['@trycua', '@ubjs']) prune(name);
  if (t.cua) {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@trycua/cua-driver'];
    let driver;
    try {
      driver = await packageDir('@trycua/cua-driver', version, cacheDir, log);
    } catch (error) {
      fail('@trycua/cua-driver', `@trycua/cua-driver@${version} could not be fetched (${error.message})`);
    }
    const manifest = JSON.parse(readFileSync(join(driver.dir, 'package.json'), 'utf8'));
    const platformName = `@trycua/cua-driver-${t.cua}`;
    const platformVersion = manifest.optionalDependencies?.[platformName];
    if (!platformVersion) fail('@trycua/cua-driver', `${platformName} is not among its optionalDependencies (${Object.keys(manifest.optionalDependencies ?? {}).join(', ')})`);
    const parts = [{ name: '@trycua/cua-driver', ...driver }];
    for (const [name, wanted] of [...Object.entries(manifest.dependencies ?? {}), [platformName, platformVersion]]) {
      try {
        parts.push({ name, ...(await packageDir(name, wanted, cacheDir, log)) });
      } catch (error) {
        fail('@trycua/cua-driver', `${name}@${wanted} could not be fetched (${error.message})`);
      }
    }
    for (const part of parts) cpSync(part.dir, join(modulesOut, part.name), { recursive: true });
    const platformDir = join(modulesOut, platformName);
    const library = cuaLibrary(t.platform);
    for (const file of [library, 'cua_driver_node_runtime.node']) {
      if (!existsSync(join(platformDir, file))) fail('@trycua/cua-driver', `${platformName}@${platformVersion} has no ${file} (it ships: ${readdirSync(platformDir).join(', ')})`);
      rows.push({ module: '@trycua/cua-driver', file: `${platformName}/${file}`, source: parts.at(-1).source });
    }
  }

  // ---- pi-tui's clipboard helper: one prebuilt .node per OS and architecture
  const piAssets = join(dirname(modulesOut), 'assets', 'pi');
  const tuiNative = join(piAssets, 'native');
  if (existsSync(tuiNative)) {
    for (const os of readdirSync(tuiNative, { withFileTypes: true })) {
      if (!os.isDirectory()) continue;
      if (os.name !== t.platform) rmSync(join(tuiNative, os.name), { recursive: true, force: true });
      else {
        const prebuilds = join(tuiNative, os.name, 'prebuilds');
        if (existsSync(prebuilds)) for (const entry of readdirSync(prebuilds)) if (entry !== triple) rmSync(join(prebuilds, entry), { recursive: true, force: true });
      }
    }
    const folder = join(tuiNative, t.platform, 'prebuilds', triple);
    const node = existsSync(folder) ? readdirSync(folder).find((f) => f.endsWith('.node')) : undefined;
    if (!node) fail('@earendil-works/pi-tui', `native/${t.platform}/prebuilds/${triple}/ is not in the package`);
    const version = JSON.parse(readFileSync(join(piAssets, 'package.json'), 'utf8')).version;
    rows.push({ module: '@earendil-works/pi-tui', file: `native/${t.platform}/prebuilds/${triple}/${node}`, source: `prebuilds in the npm tarball, ${version} (N-API)` });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------- verification

/** The CPU a PE, Mach-O or ELF file is built for, read from its header: { format, machine } or undefined when it is none of them. A universal (fat) Mach-O, as
 *  @trycua/cua-driver ships, also lists every slice in `machines`. */
export function readHeader(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(64);
    const n = readSync(fd, head, 0, 64, 0);
    if (n >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
      const pe = head.readUInt32LE(0x3c);
      const sig = Buffer.alloc(6);
      readSync(fd, sig, 0, 6, pe);
      if (sig.toString('latin1', 0, 4) === 'PE\0\0') return { format: 'pe', machine: sig.readUInt16LE(4) };
    }
    if (n >= 8 && head.readUInt32LE(0) === 0xfeedfacf) return { format: 'macho', machine: head.readUInt32LE(4) };
    if (n >= 8 && head.readUInt32BE(0) === 0xcafebabe) {
      const count = head.readUInt32BE(4);
      const table = Buffer.alloc(20 * count);
      readSync(fd, table, 0, table.length, 8);
      const machines = Array.from({ length: count }, (_, i) => table.readUInt32BE(20 * i));
      return { format: 'macho', machine: machines[0], machines };
    }
    if (n >= 0x14 && head.toString('latin1', 0, 4) === '\x7fELF') return { format: 'elf', machine: head.readUInt16LE(0x12) };
    return undefined;
  } finally {
    closeSync(fd);
  }
}

const describe = (h) => (h ? `${h.format} ${(h.machines ?? [h.machine]).map((m) => `0x${m.toString(16)}`).join('+')}` : 'not a PE, Mach-O or ELF file');

/** Every file under `dir` for which `keep(name)` is true, as absolute paths. */
function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, keep, out);
    else if (entry.isFile() && keep(entry.name, path)) out.push(path);
  }
  return out;
}

/** What each module must have left in the staged tree, per platform. */
function expectedFiles(triple) {
  const t = TRIPLES[triple];
  const list = [`@napi-rs/keyring-${t.keyring}`, `better-sqlite3-multiple-ciphers/prebuilds/${triple}.node`, `../assets/pi/native/${t.platform}/prebuilds/${triple}`];
  if (t.platform === 'win32') list.push(`node-pty/prebuilds/${triple}/pty.node`, `node-pty/prebuilds/${triple}/conpty.node`);
  else if (t.platform === 'darwin') list.push(`keychain-store/dist/keychain_store.darwin-${t.arch}.node`, `node-pty/prebuilds/${triple}/pty.node`, `node-pty/prebuilds/${triple}/spawn-helper`);
  else if (t.platform === 'linux') list.push('node-pty/build/Release/pty.node');
  if (t.cua) {
    const library = cuaLibrary(t.platform);
    list.push('@trycua/cua-driver/dist/index.js', '@ubjs/core/package.json', '@ubjs/node/typescript/dist/resolve-lib.js', `@trycua/cua-driver-${t.cua}/${library}`, `@trycua/cua-driver-${t.cua}/cua_driver_node_runtime.node`);
  }
  return list;
}

/**
 * Checks a staged backend (`<backend>/node_modules`) for `triple`. Throws on the first class of problem, listing every offender.
 * For the machine's own triple it also loads the modules in Electron. Returns a summary line per check for the log.
 */
export function verifyStaged({ backend, triple, electron, log = console.log }) {
  const t = TRIPLES[triple];
  const modules = join(backend, 'node_modules');
  const problems = [];

  for (const rel of expectedFiles(triple)) if (!existsSync(join(modules, rel))) problems.push(`missing ${rel}`);

  // Every native file in the tree has the target's CPU (a leftover of the host, or of another platform, shows up here).
  const natives = walk(backend, (name) => /\.(node|dll|dylib|exe)$/.test(name) || name === 'spawn-helper');
  for (const file of natives) {
    const header = readHeader(file);
    const where = relative(modules, file);
    if (!header || header.format !== t.format || !(header.machines ?? [header.machine]).includes(t.machine)) problems.push(`${where} is ${describe(header)}, ${triple} needs ${t.format} 0x${t.machine.toString(16)}`);
    // N-API: the binary imports napi_* and nothing from V8 or Node directly, so it does not depend on Electron's ABI.
    if (file.endsWith('.node')) {
      const bytes = readFileSync(file);
      if (!bytes.includes('napi_')) problems.push(`${where} does not look like an N-API module (no napi_ symbols): it would need rebuilding for Electron's ABI`);
      if (bytes.includes('node_module_register') || bytes.includes('_ZN2v8')) problems.push(`${where} links against V8 or Node directly (not N-API)`);
    }
  }
  if (problems.length) throw new Error(`Native verification failed for ${triple}:\n  ${problems.join('\n  ')}`);
  log(`  headers ok: ${natives.length} native files are ${t.format} 0x${t.machine.toString(16)} (${triple}), every .node is N-API`);

  if (isHost(triple)) {
    if (!electron) throw new Error('verifyStaged needs the electron binary to load the host target');
    loadInElectron({ backend, electron, log });
  } else {
    log(`  load check skipped: ${triple} cannot run on ${process.platform}-${process.arch}; headers only`);
  }
}

/** Requires the backend's native modules from the staged tree with Electron acting as Node, the way the packaged app starts the backend. */
export function loadInElectron({ backend, electron, log = console.log, label = 'staged tree' }) {
  const script = `
    (async () => {
    const { createRequire } = require('node:module');
    const { pathToFileURL } = require('node:url');
    const { join } = require('node:path');
    const req = createRequire(process.env.BACKEND + '/main.js');
    const out = [];
    const Database = req('better-sqlite3-multiple-ciphers');
    const db = new Database(':memory:');
    out.push('better-sqlite3-multiple-ciphers: sqlite ' + db.prepare('select sqlite_version() v').get().v);
    db.close();
    const { Entry } = req('@napi-rs/keyring');
    if (typeof Entry !== 'function') throw new Error('@napi-rs/keyring has no Entry');
    out.push('@napi-rs/keyring: Entry loaded');
    if (process.platform === 'darwin') {
      if (typeof req('keychain-store').openKeychainStore !== 'function') throw new Error('keychain-store has no openKeychainStore');
      out.push('keychain-store: native module loaded (no credential access)');
    }
    {
      // Computer use: the SDK's ES module, which resolves its platform package and loads the runtime and the SDK library (no driver is created, nothing is asked of macOS).
      const cua = await import(pathToFileURL(join(process.env.BACKEND, 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href);
      if (typeof cua.CuaDriver?.create !== 'function') throw new Error('@trycua/cua-driver has no CuaDriver.create');
      out.push('@trycua/cua-driver: SDK and native runtime loaded (no driver started)');
    }
    const pty = req('node-pty');
    out.push('node-pty: ' + Object.keys(pty).join(','));
    if (process.platform !== 'win32') {
      // Forks through spawn-helper: fails with "posix_spawnp failed" when the helper lost its execute bit.
      const term = pty.spawn('/bin/echo', ['pty-ok'], { cols: 80, rows: 24 });
      let seen = '';
      term.onData((d) => { seen += d; });
      term.onExit(() => { out.push('node-pty: spawned /bin/echo -> ' + JSON.stringify(seen.trim())); console.log(out.join('\\n')); process.exit(seen.includes('pty-ok') ? 0 : 3); });
      setTimeout(() => { console.log(out.join('\\n')); console.error('pty did not answer'); process.exit(4); }, 8000);
    } else {
      console.log(out.join('\\n'));
    }
    })().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(5); });
  `;
  const output = execFileSync(electron, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BACKEND: backend },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  for (const line of output.trim().split('\n')) log(`  [${label}] ${line}`);
}

export function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(path) : statSync(path).size;
  }
  return total;
}
