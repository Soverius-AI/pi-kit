// Build the backend contract and its SDK. --check compares every generated file,
// including added/deleted files, without touching the committed output.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@hey-api/openapi-ts';
import config from '../openapi-ts.config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committed = join(root, 'doc/api/openapi.yaml');
const committedSdk = join(root, config.output);
const entry = join(root, 'dist/apps/backend/openapi.js');
const args = new Set(process.argv.slice(2));
const check = args.has('--check');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, NX_DAEMON: 'false' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}

function files(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), `${name}/`) : [name];
  }).sort();
}

function same(file, generated) {
  if (!existsSync(file)) throw new Error(`${file} is missing. Run pnpm run api:openapi.`);
  if (readFileSync(file, 'utf8') === readFileSync(generated, 'utf8')) return;
  spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=2', '--', file, generated], { stdio: 'inherit' });
  throw new Error(`${file} is out of date. Run pnpm run api:openapi and commit the result.`);
}

const scratch = mkdtempSync(join(tmpdir(), 'pi-kit-openapi-'));
try {
  if (!args.has('--skip-build')) run('pnpm', ['exec', 'nx', 'build', 'backend', '--output-style=static']);
  if (!existsSync(entry)) throw new Error('Build the backend first (nx build backend).');
  const document = check ? join(scratch, 'openapi.yaml') : committed;
  run(process.execPath, [entry, document]);
  const sdk = check ? join(scratch, 'generated') : committedSdk;
  await createClient({ ...config, input: document, output: sdk });
  if (check) {
    same(committed, document);
    const names = files(sdk);
    if (JSON.stringify(names) !== JSON.stringify(files(committedSdk))) throw new Error('The generated SDK file list changed. Run pnpm run api:openapi.');
    for (const name of names) same(join(committedSdk, name), join(sdk, name));
    console.log('OpenAPI document and shared/api SDK are up to date.');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
