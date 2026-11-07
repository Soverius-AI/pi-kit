// The server tarball (doc/designs/headless-cli-server.md §1): for each staged target, the server folder with the Node runtime it
// runs on, for machines without the desktop app. Nothing in it runs on a Node.js the user installed.
//
//   node scripts/package-server.mjs [--target darwin-arm64 --target linux-x64 ...] [--runtime-cache <dir>]
//
// dist/server/pi-kit-server-<version>-<target>.tar.gz (.zip for win32) unpacks to one folder of that name:
//   backend/ renderer/browser/   dist/stage/<target>/ as scripts/package-stage.mjs staged it
//   runtime/                     node (node.exe) from the official release below, checked against its pinned SHA-256, and its LICENSE
//   bin/pi-kit (pi-kit.cmd)      runs backend/pi-kit.cjs on that runtime
//   package.json                 the version the host and `pi-kit --version` report
// dist/server/SHA256SUMS         one line per archive, for `pi-kit update` and the release page
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TRIPLES } from './natives.mjs';

/** Node 24 LTS; the SHA-256 of each archive as nodejs.org/dist/v<version>/SHASUMS256.txt publishes it. */
const NODE = {
  version: '24.22.2',
  archives: {
    'darwin-arm64': ['darwin-arm64.tar.gz', 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a'],
    'darwin-x64': ['darwin-x64.tar.gz', 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52'],
    'linux-arm64': ['linux-arm64.tar.gz', '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2'],
    'linux-x64': ['linux-x64.tar.gz', '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9'],
    'win32-arm64': ['win-arm64.zip', 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468'],
    'win32-x64': ['win-x64.zip', 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'],
  },
};

const LAUNCHER = `#!/bin/sh
# pi-kit, on the Node runtime this server install carries. Works through a symlink on PATH.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$here/runtime/node" "$here/backend/pi-kit.cjs" "$@"
`;
const WINDOWS_LAUNCHER = `@echo off\r\nrem pi-kit, on the Node runtime this server install carries.\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\backend\\pi-kit.cjs" %*\r\n`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: { target: { type: 'string', multiple: true }, 'runtime-cache': { type: 'string' } },
});
const stage = join(root, 'dist', 'stage');
const out = join(root, 'dist', 'server');
const cache = resolve(values['runtime-cache'] ?? join(root, 'dist', 'runtime-cache'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const staged = (triple) => existsSync(join(stage, triple, 'backend', 'main.js'));
const targets = values.target?.length ? values.target : Object.keys(TRIPLES).filter(staged);
for (const triple of targets) {
  if (!NODE.archives[triple]) throw new Error(`No Node runtime is pinned for ${triple}.`);
  if (!staged(triple) || !existsSync(join(stage, triple, 'renderer', 'browser', 'index.html')))
    throw new Error(`The server for ${triple} is not staged; run scripts/package-stage.mjs --target ${triple}.`);
}
if (!targets.length) throw new Error('Nothing is staged; run scripts/package-stage.mjs first.');

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The official Node archive for a target, downloaded once into the cache and refused unless it matches the pinned hash. */
async function nodeArchive(triple) {
  const [suffix, expected] = NODE.archives[triple];
  const name = `node-v${NODE.version}-${suffix}`;
  const file = join(cache, name);
  if (!existsSync(file) || sha256(file) !== expected) {
    mkdirSync(cache, { recursive: true });
    const response = await fetch(`https://nodejs.org/dist/v${NODE.version}/${name}`);
    if (!response.ok) throw new Error(`Downloading ${name} failed: ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(file);
  if (actual !== expected) throw new Error(`${name} has SHA-256 ${actual}, not the pinned ${expected}.`);
  return { file, name: name.replace(/\.(tar\.gz|zip)$/, '') };
}

/** Unpacks a zip with bsdtar (macOS, Windows), or unzip where tar is GNU tar. */
function unzip(archive, into) {
  try {
    execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'ignore' });
  } catch {
    execFileSync('unzip', ['-q', '-o', archive, '-d', into]);
  }
}

/** Writes a zip with bsdtar's format-by-suffix, or zip where tar is GNU tar. */
function zip(folder, archive) {
  try {
    execFileSync('tar', ['-a', '-cf', archive, '-C', dirname(folder), folder.split(/[\\/]/).pop()], {
      stdio: 'ignore',
    });
  } catch {
    execFileSync('zip', ['-q', '-r', archive, folder.split(/[\\/]/).pop()], { cwd: dirname(folder) });
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sums = [];
for (const triple of targets) {
  const windows = triple.startsWith('win32-');
  const folderName = `pi-kit-server-${version}-${triple}`;
  const folder = join(out, folderName);
  cpSync(join(stage, triple, 'backend'), join(folder, 'backend'), { recursive: true, verbatimSymlinks: true });
  cpSync(join(stage, triple, 'renderer'), join(folder, 'renderer'), { recursive: true });

  const node = await nodeArchive(triple);
  const unpacked = mkdtempSync(join(tmpdir(), 'pi-kit-node-'));
  try {
    if (windows) unzip(node.file, unpacked);
    else execFileSync('tar', ['-xzf', node.file, '-C', unpacked]);
    const binary = windows ? join(unpacked, node.name, 'node.exe') : join(unpacked, node.name, 'bin', 'node');
    mkdirSync(join(folder, 'runtime'));
    cpSync(binary, join(folder, 'runtime', windows ? 'node.exe' : 'node'));
    cpSync(join(unpacked, node.name, 'LICENSE'), join(folder, 'runtime', 'LICENSE'));
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }

  mkdirSync(join(folder, 'bin'));
  if (windows) writeFileSync(join(folder, 'bin', 'pi-kit.cmd'), WINDOWS_LAUNCHER);
  else {
    writeFileSync(join(folder, 'bin', 'pi-kit'), LAUNCHER);
    chmodSync(join(folder, 'bin', 'pi-kit'), 0o755);
    chmodSync(join(folder, 'runtime', 'node'), 0o755);
  }
  writeFileSync(
    join(folder, 'package.json'),
    `${JSON.stringify({ name: 'pi-kit-server', version, private: true, description: `The pi-kit server for ${triple}, with Node ${NODE.version}` }, null, 2)}\n`,
  );

  const archive = join(out, `${folderName}${windows ? '.zip' : '.tar.gz'}`);
  if (windows) zip(folder, archive);
  else execFileSync('tar', ['-czf', archive, '-C', out, folderName]);
  rmSync(folder, { recursive: true, force: true });
  sums.push(`${sha256(archive)}  ${archive.split(/[\\/]/).pop()}`);
  console.log(`${archive.split(/[\\/]/).pop()}: ${mb(statSync(archive).size)} (Node ${NODE.version})`);
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
