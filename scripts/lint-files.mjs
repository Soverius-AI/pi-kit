import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const groups = new Map();
for (const input of process.argv.slice(2)) {
  const file = resolve(input);
  const name = relative(root, file).replaceAll('\\', '/');
  if (name.startsWith('../') || !/\.(?:[cm]?js|tsx?|html)$/.test(name) || /^(?:libs\/shared\/api\/src\/generated|output|dist|node_modules)\//.test(name) || !existsSync(file)) continue;
  let dir = dirname(file);
  while (dir !== root.slice(0, -1) && !existsSync(resolve(dir, 'eslint.config.mjs'))) dir = dirname(dir);
  const config = resolve(dir, 'eslint.config.mjs');
  groups.set(config, [...(groups.get(config) ?? []), file]);
}
for (const [config, files] of groups) {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/eslint/bin/eslint.js'), '--config', config, '--fix', ...files], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
