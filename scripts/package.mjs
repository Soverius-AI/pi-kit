// One platform's installers. `pnpm run release` (scripts/release.mjs) calls this once per platform.
//
//   node scripts/package.mjs <mac|win|linux> [--arch x64|arm64 ...] [--dir] [--skip-build]
//
//   mac    arm64 (the default)    -> pi-kit-<v>-mac-arm64.dmg + .zip, latest-mac.yml
//   win    x64 and arm64          -> pi-kit-<v>-win-<arch>.exe (installer) + -portable.exe per arch, one latest.yml that lists both installers
//   linux  host architecture      -> AppImage + architecture-specific update metadata (requires a matching Linux host)
//
// 1. scripts/package-stage.mjs builds the apps (unless --skip-build), stages the shell (dist/package) and one backend per target
//    architecture (dist/stage/<platform>-<arch>/backend) with that target's natives, and verifies them,
// 2. electron-builder packs all the architectures of the platform in one run (that is what puts both Windows installers into one latest.yml)
//    into dist/release. `--dir` stops at the unpacked apps, which is what the smoke test (scripts/release-smoke.mjs) launches.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertLinuxHost } from './release-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'boolean', default: false }, arch: { type: 'string', multiple: true }, 'skip-build': { type: 'boolean', default: false } },
});
const platforms = {
  mac: { platform: 'darwin', flag: '--mac', archs: ['arm64'] },
  linux: { platform: 'linux', flag: '--linux', archs: [process.arch] },
  win: { platform: 'win32', flag: '--win', archs: ['x64', 'arm64'] },
};
const group = platforms[positionals[0]];
if (!group) {
  console.error('Usage: node scripts/package.mjs <mac|win|linux> [--dir] [--arch x64|arm64 ...] [--skip-build]');
  process.exit(2);
}
const archs = (values.arch?.length ? values.arch.flatMap((a) => a.split(',')) : group.archs).map((a) => a.trim());
for (const arch of archs) if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unknown architecture ${arch}`);
assertLinuxHost(archs.map((arch) => `${group.platform}-${arch}`));
const run = (command, args, env = {}) => {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
};
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

let started = Date.now();
run(process.execPath, [join(root, 'scripts/package-stage.mjs'), ...archs.flatMap((arch) => ['--target', `${group.platform}-${arch}`]), ...(values['skip-build'] ? ['--skip-build'] : [])]);
console.log(`staged ${archs.map((a) => `${group.platform}-${a}`).join(', ')} in ${seconds(started)}`);

started = Date.now();
run(
  process.execPath,
  [join(root, 'node_modules/electron-builder/cli.js'), group.flag, ...archs.map((arch) => `--${arch}`), ...(values.dir ? ['--dir'] : []), '--publish', 'never', '--config', 'electron-builder.config.cjs'],
  // The config reuses the workspace's own Electron when the one target is the machine's (no download); the other targets download theirs once into electron's cache.
  { PI_KIT_BUILD_PLATFORM: group.platform, PI_KIT_BUILD_ARCHS: archs.join(',') },
);
console.log(`packed ${group.platform} (${archs.join(', ')}${values.dir ? ', --dir' : ''}) in ${seconds(started)}`);
