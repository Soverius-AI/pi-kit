// After `pnpm install` (the root project's own script, so `allowBuilds` does not apply to it): node-pty's prebuilt
// `spawn-helper` lands without its execute bit (seen with npm 11 on macOS, and again with pnpm 11: the first install here fixed 2 files),
// and then every terminal fails with "posix_spawnp failed". The backend guards against it at runtime too
// (`ensureSpawnHelper` in apps/backend/src/terminal/terminal.service.ts), but the bundled backend cannot always resolve
// node-pty's folder, so the install is the reliable place. Safe to run anywhere: it only chmods files that exist.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'node_modules', 'node-pty');
const dirs = [];
const prebuilds = join(root, 'prebuilds');
if (existsSync(prebuilds)) for (const entry of readdirSync(prebuilds)) dirs.push(join(prebuilds, entry));
dirs.push(join(root, 'build', 'Release'));

let fixed = 0;
for (const dir of dirs) {
  const helper = join(dir, 'spawn-helper');
  if (!existsSync(helper)) continue;
  if ((statSync(helper).mode & 0o111) === 0) fixed++;
  chmodSync(helper, 0o755);
}
if (fixed) console.log(`postinstall: made ${fixed} node-pty spawn-helper executable`);
