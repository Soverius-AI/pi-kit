import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { LEARN_PACKAGE, LearnPackage } from './learn-package';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

const SOURCE = resolve(__dirname, '..', '..', '..', '..', 'packages', 'pi-kit-learn');
const FILES = ['package.json', 'extensions/learn.ts', 'lib/analysis.mjs', 'prompts/analyze.md', 'templates/SKILL.md'];

let base: string;
let agent: string;
let bundled: string;
let db: DatabaseService;
let pkg: LearnPackage;
const previous = { agent: process.env['PI_CODING_AGENT_DIR'], dir: process.env['PI_KIT_LEARN_PACKAGE_DIR'], off: process.env['PI_KIT_LEARN_PACKAGE'] };

/** A copy of the package as the app ships it (no specs), where `dir` says. */
function ship(dir: string): void {
  for (const file of FILES) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    cpSync(join(SOURCE, file), join(dir, file));
  }
}
const settings = (): { packages?: unknown[] } => (existsSync(join(agent, 'settings.json')) ? JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8')) : {});

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-learnpkg-')));
  agent = join(base, 'agent');
  bundled = join(base, 'app', 'packages', 'pi-kit-learn');
  mkdirSync(agent, { recursive: true });
  ship(bundled);
  process.env['PI_CODING_AGENT_DIR'] = agent;
  process.env['PI_KIT_LEARN_PACKAGE_DIR'] = bundled;
  delete process.env['PI_KIT_LEARN_PACKAGE'];
  db = new DatabaseService({ dataDir: join(base, 'data') });
  pkg = new LearnPackage(new MetaRepository(db));
  // A test runner's sandbox has no native `import()`; the package's own file is imported the runner's way.
  pkg.importer = <T>(url: string) => import(/* @vite-ignore */ url) as Promise<T>;
});
afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
  for (const [key, value] of [['PI_CODING_AGENT_DIR', previous.agent], ['PI_KIT_LEARN_PACKAGE_DIR', previous.dir], ['PI_KIT_LEARN_PACKAGE', previous.off]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the learn package ships with the app and is installed into pi once', () => {
  it('is a pi package: the pi key names the extension, and the files are there', () => {
    const manifest = JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8'));
    expect(manifest.name).toBe(LEARN_PACKAGE);
    expect(manifest.keywords).toContain('pi-package');
    expect(manifest.pi.extensions).toEqual(['./extensions/learn.ts']);
    for (const file of FILES) expect(existsSync(join(SOURCE, file)), file).toBe(true);
  });

  it('adds the bundled folder to the user’s pi settings the first time, and pi lists it', async () => {
    expect(await pkg.installedDir()).toBeUndefined();
    expect(await pkg.ensureInstalled()).toBe('installed');
    expect(settings().packages).toHaveLength(1);
    expect(await pkg.installedDir()).toBe(bundled);
  });

  it('does nothing the second time', async () => {
    await pkg.ensureInstalled();
    const before = readFileSync(join(agent, 'settings.json'), 'utf8');
    expect(await pkg.ensureInstalled()).toBe('present');
    expect(readFileSync(join(agent, 'settings.json'), 'utf8')).toBe(before);
  });

  it('stays removed after `pi remove`', async () => {
    await pkg.ensureInstalled();
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [] }));
    expect(await pkg.installedDir()).toBeUndefined();
    expect(await pkg.ensureInstalled()).toBe('removed-by-user');
    expect(settings().packages).toEqual([]);
    expect(await pkg.analysis()).toBeUndefined();
  });

  it('points a moved app at the copy it ships now', async () => {
    const old = join(base, 'old-app', 'packages', 'pi-kit-learn');
    ship(old);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [old] }));
    expect(await pkg.installedDir()).toBe(old);
    rmSync(join(base, 'old-app'), { recursive: true, force: true });
    expect(await pkg.ensureInstalled()).toBe('repointed');
    expect(settings().packages).toHaveLength(1);
    expect(await pkg.installedDir()).toBe(bundled);
  });

  it('is skipped when the environment says so', async () => {
    process.env['PI_KIT_LEARN_PACKAGE'] = 'off';
    expect(await pkg.ensureInstalled()).toBe('off');
    expect(existsSync(join(agent, 'settings.json'))).toBe(false);
  });

  it('loads the analysis of the installed copy', async () => {
    await pkg.ensureInstalled();
    const analysis = await pkg.analysis();
    expect(analysis?.parseDraftReply('---\nname: x-y\ndescription: Use when z\n---\n\nBody\n')).toMatchObject({ ok: true, name: 'x-y' });
    expect(analysis?.buildAnalysisPrompt({ threadId: 't', title: null, cwd: '/', prompts: ['p'], toolCalls: 0, steps: [], errors: [], checks: [], diff: null, changedLines: 0, commitMessage: null, base: null, head: null, truncated: false, redactions: 0 }).system).toContain('SKILL.md');
  });
});
