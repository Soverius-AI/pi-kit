import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import config from '../prettier.config.mjs';
import { angularRoots, isAngularSource } from './frontend-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.includes('--write');
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).map((file) => relative(root, resolve(file)));
const files = (requested.length ? requested : angularRoots.flatMap((dir) => [...globSync(`${dir}/src/**/*.{ts,html,css}`, { cwd: root })])).filter(isAngularSource);
let stale = 0;
for (const file of files) {
  const path = resolve(root, file);
  const source = readFileSync(path, 'utf8');
  const formatted = await prettier.format(source, { ...config, filepath: file, ...(file.endsWith('.html') ? { parser: 'angular' } : {}) });
  if (source === formatted) continue;
  if (write) writeFileSync(path, formatted);
  else { console.error(file); stale++; }
}
console.log(`${write ? 'Formatted' : 'Checked'} ${files.length} Angular files${stale ? `; ${stale} need formatting` : ''}.`);
if (stale) process.exitCode = 1;
