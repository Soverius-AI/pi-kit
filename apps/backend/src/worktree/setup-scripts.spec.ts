import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyScriptFiles, detectSetupScript, detectSetupScriptIn, effectiveScripts, pickScript, safeCopyPath } from './setup-scripts';

const has = (...files: string[]) => (file: string) => files.includes(file);

describe('the script a lockfile suggests', () => {
  it('maps each lockfile to its install command', () => {
    expect(detectSetupScript(has('pnpm-lock.yaml'))).toEqual({ id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' });
    expect(detectSetupScript(has('bun.lock'))).toEqual({ id: 'bun', name: 'bun', command: 'bun install' });
    expect(detectSetupScript(has('bun.lockb'))).toMatchObject({ name: 'bun', command: 'bun install' });
    expect(detectSetupScript(has('yarn.lock'))).toEqual({ id: 'yarn', name: 'yarn', command: 'yarn install --immutable' });
    expect(detectSetupScript(has('package-lock.json'))).toEqual({ id: 'npm', name: 'npm', command: 'npm ci' });
  });

  it('suggests nothing without one of them', () => {
    expect(detectSetupScript(has('package.json', 'Cargo.lock', 'poetry.lock'))).toBeUndefined();
    expect(detectSetupScript(has())).toBeUndefined();
  });

  it('takes the first of pnpm, bun, yarn, npm when a folder has several', () => {
    expect(detectSetupScript(has('package-lock.json', 'pnpm-lock.yaml'))?.name).toBe('pnpm');
    expect(detectSetupScript(has('package-lock.json', 'yarn.lock'))?.name).toBe('yarn');
    expect(detectSetupScript(has('yarn.lock', 'bun.lockb'))?.name).toBe('bun');
  });
});

describe('the scripts a project has', () => {
  const detect = () => detectSetupScript(has('package-lock.json'));

  it('prefers the saved list, even an empty one (the person chose none)', () => {
    const saved = [{ id: 'a', name: 'A', command: 'make' }];
    expect(effectiveScripts({ saved, detect })).toEqual(saved);
    expect(effectiveScripts({ saved: [], detect })).toEqual([]);
  });

  it('falls back to the lockfile, and to nothing', () => {
    expect(effectiveScripts({ saved: null, detect })).toEqual([{ id: 'npm', name: 'npm', command: 'npm ci' }]);
    expect(effectiveScripts({ saved: null, detect: () => undefined })).toEqual([]);
  });

  it('picks the first by default, none for null, and a named one by id', () => {
    const scripts = [
      { id: 'a', name: 'A', command: 'one' },
      { id: 'b', name: 'B', command: 'two' },
    ];
    expect(pickScript(scripts, undefined)?.id).toBe('a');
    expect(pickScript(scripts, null)).toBeUndefined();
    expect(pickScript(scripts, 'b')?.command).toBe('two');
    expect(pickScript([], undefined)).toBeUndefined();
    expect(() => pickScript(scripts, 'nope')).toThrow(/no setup script/);
  });
});

describe('the files a script copies', () => {
  let from: string;
  let to: string;
  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-copy-')));
    from = join(base, 'from');
    to = join(base, 'to');
    mkdirSync(join(from, 'config'), { recursive: true });
    mkdirSync(to);
    writeFileSync(join(from, '.env.local'), 'KEY=1\n');
    writeFileSync(join(from, 'config', 'dev.json'), '{}');
  });
  afterEach(() => rmSync(join(from, '..'), { recursive: true, force: true }));

  it('accepts only relative paths inside the project', () => {
    expect(safeCopyPath('.env.local')).toBe('.env.local');
    expect(safeCopyPath('config/dev.json')).toBe('config/dev.json');
    expect(safeCopyPath('../secret')).toBeUndefined();
    expect(safeCopyPath('/etc/passwd')).toBeUndefined();
    expect(safeCopyPath('..')).toBeUndefined();
    expect(safeCopyPath('.')).toBeUndefined();
  });

  it('copies the files that exist, with their folders, and skips the rest', () => {
    const copied = copyScriptFiles({ id: 'x', name: 'X', command: '', copy: ['.env.local', 'config/dev.json', 'missing.txt', '../escape'] }, from, to);
    expect(copied).toEqual(['.env.local', 'config/dev.json']);
    expect(readFileSync(join(to, '.env.local'), 'utf8')).toBe('KEY=1\n');
    expect(existsSync(join(to, 'config', 'dev.json'))).toBe(true);
    expect(existsSync(join(to, 'missing.txt'))).toBe(false);
  });

  it('reads the lockfile of a folder on disk', () => {
    expect(detectSetupScriptIn(from)).toBeUndefined();
    writeFileSync(join(from, 'pnpm-lock.yaml'), '');
    expect(detectSetupScriptIn(from)?.name).toBe('pnpm');
  });
});
