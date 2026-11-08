// The npm channel (doc/designs/headless-cli-server.md §1): the release's server archives as npm packages.
//
//   node scripts/package-npm.mjs [--from dist/release] [--out dist/npm]
//
// dist/npm/<target>/   @soverius-ai/pi-kit-<target>: the server archive of that target unpacked as it is, with a package.json
//                      whose os and cpu let npm install only the machine's own; it runs on its runtime/node like the archive
// dist/npm/pi-kit/     @soverius-ai/pi-kit: bin/pi-kit.js (scripts/npm/pi-kit.js) runs the machine's platform package, one of
//                      its optional dependencies, pinned to this version
// Publish the platform packages first, so the launcher never names a version that is not there yet.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { unpack } from './archives.mjs';
import { TRIPLES } from './natives.mjs';
import releaseRepo from './release-repo.cjs';

const SCOPE = '@soverius-ai';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } });
const from = resolve(values.from ?? join(root, 'dist', 'release'));
const out = resolve(values.out ?? join(root, 'dist', 'npm'));
const { version, license, author } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// npm checks provenance against this repository.
const meta = {
  version,
  license,
  author,
  repository: { type: 'git', url: `git+https://github.com/${releaseRepo}.git` },
};
const write = (dir, manifest) => writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const archives = Object.keys(TRIPLES).map((target) => ({
  target,
  file: join(from, `pi-kit-server-${version}-${target}${target.startsWith('win32-') ? '.zip' : '.tar.gz'}`),
}));
const missing = archives.filter(({ file }) => !existsSync(file));
if (missing.length) throw new Error(`Missing server archives:\n  ${missing.map(({ file }) => file).join('\n  ')}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const { target, file } of archives) {
  const unpacked = mkdtempSync(join(tmpdir(), 'pi-kit-npm-'));
  try {
    unpack(file, unpacked);
    renameSync(join(unpacked, `pi-kit-server-${version}-${target}`), join(out, target));
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
  const { platform, arch } = TRIPLES[target];
  const { releases } = JSON.parse(readFileSync(join(out, target, 'package.json'), 'utf8'));
  write(join(out, target), {
    name: `${SCOPE}/pi-kit-${target}`,
    description: `The pi-kit server for ${target}, with its own Node.js runtime. Install ${SCOPE}/pi-kit instead.`,
    ...meta,
    os: [platform],
    cpu: [arch],
    files: ['backend', 'renderer', 'runtime', 'bin'],
    // The CLI reads these: the release feed for `pi-kit update --check`, and npm's own package for `pi-kit update`.
    releases,
    npm: `${SCOPE}/pi-kit`,
  });
  console.log(`${SCOPE}/pi-kit-${target}@${version}`);
}

const launcher = join(out, 'pi-kit');
mkdirSync(join(launcher, 'bin'), { recursive: true });
cpSync(join(root, 'scripts', 'npm', 'pi-kit.js'), join(launcher, 'bin', 'pi-kit.js'));
cpSync(join(root, 'scripts', 'npm', 'README.md'), join(launcher, 'README.md'));
write(launcher, {
  name: `${SCOPE}/pi-kit`,
  description: 'The pi-kit server and CLI for Linux, macOS and Windows, with its own Node.js runtime.',
  ...meta,
  bin: { 'pi-kit': 'bin/pi-kit.js' },
  files: ['bin'],
  engines: { node: '>=18' },
  optionalDependencies: Object.fromEntries(archives.map(({ target }) => [`${SCOPE}/pi-kit-${target}`, version])),
});
console.log(`${SCOPE}/pi-kit@${version}`);
