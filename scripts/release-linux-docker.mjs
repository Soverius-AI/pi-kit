// pnpm run package:linux:docker [-- --arch arm64|x64] [--dir] [--smoke] [--fresh] [--shell]
//
// A Linux AppImage from a Mac (or any Docker host): node-pty has no Linux prebuilds, so `pnpm run release --only linux-*` needs a
// Linux host of the target CPU (scripts/release-targets.mjs). This runs that same release inside a Linux container of the target
// CPU. An Apple Silicon Mac runs the arm64 container natively; `--arch x64` runs under Docker's emulation (slower, same result).
//
// The image (node 24 on Debian, the Electron runtime libraries and Xvfb the release workflow installs, pnpm as package.json pins it)
// is built once per CPU as pi-kit-linux-release:<arch>; Docker's cache makes later runs skip it. The working tree is copied, without
// node_modules, dist and .git, into a volume that keeps the container's install, pnpm store and build output between runs (`--fresh`
// drops it). The AppImage and latest-linux*.yml land in dist/release/ on the host, where `pnpm run release` puts them;
// `--dir` copies the unpacked app folder instead. `--smoke` runs scripts/release-smoke.mjs on the AppImage under Xvfb, as the
// workflow does. `--shell` opens a bash in the prepared container instead of building.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseTargets } from './release-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    arch: { type: 'string', default: process.arch },
    dir: { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    shell: { type: 'boolean', default: false },
  },
});
const archs = { arm64: { docker: 'linux/arm64', appimage: 'arm64' }, x64: { docker: 'linux/amd64', appimage: 'x86_64' } };
const arch = archs[values.arch];
if (!arch) {
  console.error(`Unknown --arch "${values.arch}". Usage: node scripts/release-linux-docker.mjs [--arch arm64|x64] [--dir] [--smoke] [--fresh] [--shell]`);
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pnpmVersion = /^pnpm@(.+)$/.exec(pkg.packageManager ?? '')?.[1];
if (!pnpmVersion) throw new Error('package.json "packageManager" must pin pnpm (pnpm@<version>)');
const target = releaseTargets(pkg.version)[`linux-${values.arch}`];
const image = `pi-kit-linux-release:${values.arch}`;
const workVolume = `pi-kit-linux-release-${values.arch}`;
const cacheVolume = `pi-kit-linux-release-cache-${values.arch}`;
const release = join(root, 'dist', 'release');

const docker = (args, options = {}) => {
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error?.code === 'ENOENT') throw new Error('Docker is not installed (or not on PATH). Linux builds on a Mac run in a Linux container: install Docker Desktop, or build on a Linux host of the target CPU.');
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (exit code ${result.status})`);
  return result;
};

docker(['info'], { stdio: 'ignore' });
if (values.fresh) {
  for (const volume of [workVolume, cacheVolume]) spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
}

// ---- the image: what the release workflow's Linux job installs on its runner
const dockerfile = `
FROM node:24-bookworm
ARG PNPM_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \\
      libgtk-3-0 libnss3 libasound2 libgbm1 libsecret-1-0 libxtst6 libxss1 xvfb xauth rsync \\
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@\${PNPM_VERSION}
ENV NX_DAEMON=false CI=1 ELECTRON_CACHE=/root/.cache/electron
WORKDIR /work
`;
console.log(`=== image ${image} (${arch.docker})`);
docker(['build', '--platform', arch.docker, '--build-arg', `PNPM_VERSION=${pnpmVersion}`, '-t', image, '-'], { input: dockerfile, stdio: ['pipe', 'inherit', 'inherit'] });

// ---- the build, in a copy of the working tree that lives in the volume
mkdirSync(release, { recursive: true });
const tty = process.stdout.isTTY && process.stdin.isTTY;
const runArgs = [
  // --init reaps what Xvfb and Electron leave behind; without it xvfb-run never returns as PID 1.
  'run', '--rm', '--init', ...(tty ? ['-it'] : []), '--platform', arch.docker,
  '-v', `${root}:/src:ro`, '-v', `${release}:/out`, '-v', `${workVolume}:/work`, '-v', `${cacheVolume}:/root/.cache`,
  image,
];
const sync = `rsync -a --delete --exclude node_modules --exclude /dist --exclude /.git --exclude /.nx --exclude /.angular --exclude /.pnpm-store /src/ /work/`;
if (values.shell) {
  console.log(`\n=== shell in ${image}: the tree is in /work (synced from this checkout), dist/release of the host is /out`);
  docker([...runArgs, 'bash', '-c', `${sync} && exec bash`]);
  process.exit(0);
}
const outputs = values.dir
  ? [`rsync -a --delete dist/release/${target.unpacked}/ /out/${target.unpacked}/`]
  : [`cp -f ${target.artifacts.map((a) => `dist/release/${a}`).join(' ')} dist/release/${target.updateInfo} /out/`]; // an AppImage embeds its block map
const steps = [
  'set -euo pipefail',
  `echo "=== sync the working tree into the ${workVolume} volume"`,
  sync,
  'echo "=== pnpm install (node-pty compiles here)"',
  'pnpm install --frozen-lockfile --store-dir /work/.pnpm-store',
  `node scripts/release.mjs --only linux-${values.arch}${values.dir ? ' --dir' : ''}`,
  // The container runs as root, which Electron only allows without its sandbox (the smoke test launches the real app).
  ...(values.smoke && !values.dir ? [`ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node scripts/release-smoke.mjs dist/release/pi-kit-${pkg.version}-linux-${arch.appimage}.AppImage`] : []),
  ...outputs,
];
docker([...runArgs, 'bash', '-c', steps.join('\n')]);

// ---- what reached the host
const expected = values.dir ? [target.unpacked] : [...target.artifacts, target.updateInfo];
const missing = expected.filter((file) => !existsSync(join(release, file)));
if (missing.length) {
  for (const file of missing) console.error(`MISSING dist/release/${file}`);
  process.exit(1);
}
console.log(`\nlinux-${values.arch} (Docker): ${expected.map((f) => `dist/release/${f}`).join(', ')}`);
