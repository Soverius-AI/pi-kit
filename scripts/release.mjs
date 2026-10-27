// pnpm run release.
//
//   node scripts/release.mjs [--only mac|win|win-x64|win-arm64|linux|linux-x64|linux-arm64 ...] [--dir] [--skip-build]
//
// One build of renderer, backend, desktop and the secret CLI, then stage and pack per platform (scripts/package.mjs):
//   mac        darwin-arm64            pi-kit-<v>-mac-arm64.dmg + .zip, latest-mac.yml
//   win-x64    win32-x64               pi-kit-<v>-win-x64.exe (installer) + pi-kit-<v>-win-x64-portable.exe
//   win-arm64  win32-arm64             pi-kit-<v>-win-arm64.exe + pi-kit-<v>-win-arm64-portable.exe
//   linux-x64  linux-x64               pi-kit-<v>-linux-x86_64.AppImage, latest-linux.yml
//   linux-arm64 linux-arm64            pi-kit-<v>-linux-arm64.AppImage, latest-linux-arm64.yml
// everything in dist/release/, with latest.yml (both Windows installers) and the .blockmap files electron-updater uses.
// `--only` takes one or more of the names above (comma separated or repeated); `win` is both Windows targets, which are packed in one
// electron-builder run so that latest.yml lists both. `linux` selects the host's architecture; it requires a matching Linux host.
// `--dir` stops at the unpacked apps. Without `--only`, Linux builds its native target; other hosts build macOS and Windows.
// A target that fails is reported and the rest still run, the exit code is then 1.
//
// Signing and notarization are opt-in through CSC_* / WIN_CSC_* / APPLE_* / PI_KIT_NOTARIZE (see electron-builder.config.cjs
// and .github/workflows/release.yml); publishing and tagging are the workflow's job.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { verifyStaged } from './natives.mjs';
import { assertLinuxHost, releaseTargets, selectTargets } from './release-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: { only: { type: 'string', multiple: true }, dir: { type: 'boolean', default: false }, 'skip-build': { type: 'boolean', default: false } },
});
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const release = join(root, 'dist', 'release');

/** Every target: the platform group that packs it, its triple, the files a complete build leaves, and the unpacked folder. */
const TARGETS = releaseTargets(version);
const selected = selectTargets(values.only);
for (const name of selected) {
  if (!TARGETS[name]) {
    console.error(`Unknown target "${name}". Usage: node scripts/release.mjs [--only mac|win|win-x64|win-arm64|linux|linux-x64|linux-arm64 ...] [--dir] [--skip-build]`);
    process.exit(2);
  }
}
assertLinuxHost(selected.map((name) => TARGETS[name].triple));
const seconds = (since) => ((Date.now() - since) / 1000).toFixed(0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });

// Earlier output of the same targets would otherwise be mistaken for this run's.
mkdirSync(release, { recursive: true });
for (const name of selected) {
  const t = TARGETS[name];
  for (const file of [...t.artifacts, ...t.artifacts.map((a) => `${a}.blockmap`)]) rmSync(join(release, file), { force: true });
  rmSync(join(release, t.unpacked), { recursive: true, force: true });
  rmSync(join(root, 'dist', 'stage', t.triple), { recursive: true, force: true });
}
for (const info of new Set(selected.map((n) => TARGETS[n].updateInfo))) rmSync(join(release, info), { force: true });

const timings = [];
const started = Date.now();
if (!values['skip-build']) {
  const t0 = Date.now();
  run([join(root, 'scripts/package-stage.mjs'), '--build-only']);
  timings.push({ step: 'build (renderer, backend, desktop, secret-cli)', seconds: seconds(t0) });
}

// The Windows archs share one electron-builder run (and so one latest.yml).
const groups = [...new Set(selected.map((n) => TARGETS[n].group))];
const failures = [];
for (const group of groups) {
  const archs = selected.filter((n) => TARGETS[n].group === group).map((n) => TARGETS[n].arch);
  const t0 = Date.now();
  console.log(`\n=== ${group} (${archs.join(', ')}) ===`);
  try {
    run([join(root, 'scripts/package.mjs'), group, '--skip-build', ...archs.flatMap((a) => ['--arch', a]), ...(values.dir ? ['--dir'] : [])]);
    timings.push({ step: `${group} ${archs.join(' + ')}: stage, verify natives, pack`, seconds: seconds(t0) });
  } catch (error) {
    timings.push({ step: `${group} ${archs.join(' + ')}: FAILED`, seconds: seconds(t0) });
    for (const arch of archs) failures.push(`${group}-${arch}: ${error.message.split('\n')[0]}`);
  }
}

// ---- the natives once more, in the packed apps themselves (the unpacked folders electron-builder packed the installers from)
for (const name of selected) {
  const t = TARGETS[name];
  if (failures.some((f) => f.startsWith(`${t.group}-${t.arch}`))) continue;
  const backend = t.group === 'mac' ? join(release, t.unpacked, 'pi-kit.app', 'Contents', 'Resources', 'backend') : join(release, t.unpacked, 'resources', 'backend');
  console.log(`\nnatives in the packed ${name} app:`);
  try {
    verifyStaged({ backend, triple: t.triple, electron: createRequire(import.meta.url)('electron') });
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

// ---- what is in dist/release now
console.log('\n=== dist/release ===');
const missing = [];
if (existsSync(release)) {
  const rows = readdirSync(release, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('builder-')).sort((a, b) => a.name.localeCompare(b.name));
  for (const row of rows) console.log(`  ${row.name.padEnd(48)} ${mb(statSync(join(release, row.name)).size).padStart(10)}`);
}
if (!values.dir) {
  for (const name of selected) {
    if (failures.some((f) => f.startsWith(`${TARGETS[name].group}-${TARGETS[name].arch}`))) continue;
    for (const file of [...TARGETS[name].artifacts, TARGETS[name].updateInfo]) if (!existsSync(join(release, file))) missing.push(`${name}: ${file}`);
  }
}
console.log('\n=== time ===');
for (const t of timings) console.log(`  ${String(t.seconds).padStart(5)} s  ${t.step}`);
console.log(`  ${String(seconds(started)).padStart(5)} s  total`);
if (failures.length || missing.length) {
  for (const f of failures) console.error(`FAILED  ${f}`);
  for (const m of missing) console.error(`MISSING ${m}`);
  process.exit(1);
}
console.log(`\nrelease ${version}: ${selected.join(', ')} done`);
