// A fake managed pi install for the update tests: the layout pi's installer writes under <agent dir>/install, with one release
// that is the bundled pi copied under another version number. The release's dependencies are links to the workspace's node_modules, so
// it loads without a second install; its `package.json` names the fake version, which is what the backend's resolution (and pi's own VERSION) read.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './env.mjs';

const SCOPE = '@earendil-works';
const PI = 'pi-coding-agent';

/** Adds `version` as a managed release and makes it current; returns the release folder. */
export function addFakeRelease(agentDir, version, { current = true } = {}) {
  const install = join(agentDir, 'install');
  const release = join(install, 'releases', version);
  const modules = join(release, 'node_modules');
  mkdirSync(join(modules, SCOPE), { recursive: true });
  writeFileSync(join(install, 'managed-install.json'), `${JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })}\n`);
  writeFileSync(join(release, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent-install', version, private: true }));
  const source = join(root, 'node_modules');
  for (const name of readdirSync(source)) {
    if (name === SCOPE || name === '.bin' || name.startsWith('.')) continue;
    if (!existsSync(join(modules, name))) symlinkSync(join(source, name), join(modules, name));
  }
  for (const name of readdirSync(join(source, SCOPE))) {
    if (name !== PI && !existsSync(join(modules, SCOPE, name))) symlinkSync(join(source, SCOPE, name), join(modules, SCOPE, name));
  }
  const copy = join(modules, SCOPE, PI);
  rmSync(copy, { recursive: true, force: true });
  cpSync(join(source, SCOPE, PI), copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  if (current) writeFileSync(join(install, 'current-version'), `${version}\n`);
  return release;
}
