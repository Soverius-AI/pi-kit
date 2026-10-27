import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { LearnPackage } from '../learn/learn-package';
import { MEAT_PROXY_PACKAGE, MeatProxyPackage } from './meat-proxy-package';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

const ROOT = resolve(__dirname, '..', '..', '..', '..', 'packages');
const FILES = ['package.json', 'extensions/meat-proxy.ts', 'lib/hunks.mjs', 'lib/ledger.mjs', 'lib/score.mjs', 'lib/attribution.mjs', 'lib/pipeline.mjs', 'prompts/attribute.md'];
const LEARN_FILES = ['package.json', 'extensions/learn.ts', 'lib/analysis.mjs', 'prompts/analyze.md', 'templates/SKILL.md'];

let base: string;
let agent: string;
let meatDir: string;
let learnDir: string;
let db: DatabaseService;
let meta: MetaRepository;
let pkg: MeatProxyPackage;
const keys = ['PI_CODING_AGENT_DIR', 'PI_KIT_MEAT_PROXY_PACKAGE_DIR', 'PI_KIT_MEAT_PROXY_PACKAGE', 'PI_KIT_LEARN_PACKAGE_DIR', 'PI_KIT_LEARN_PACKAGE'] as const;
const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

/** A copy of a package as the app ships it (no specs, no fixtures), where `dir` says. */
function ship(from: string, files: string[], dir: string): void {
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    cpSync(join(ROOT, from, file), join(dir, file));
  }
}
const settings = (): { packages?: unknown[] } => (existsSync(join(agent, 'settings.json')) ? JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8')) : {});
/** pi writes a package folder relative to its agent folder when it can; the entries as absolute paths. */
const folders = (): string[] => (settings().packages ?? []).map((p) => resolve(agent, String(p)));

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-meatpkg-')));
  agent = join(base, 'agent');
  meatDir = join(base, 'app', 'packages', 'pi-kit-meat-proxy');
  learnDir = join(base, 'app', 'packages', 'pi-kit-learn');
  mkdirSync(agent, { recursive: true });
  ship('pi-kit-meat-proxy', FILES, meatDir);
  ship('pi-kit-learn', LEARN_FILES, learnDir);
  process.env['PI_CODING_AGENT_DIR'] = agent;
  process.env['PI_KIT_MEAT_PROXY_PACKAGE_DIR'] = meatDir;
  process.env['PI_KIT_LEARN_PACKAGE_DIR'] = learnDir;
  delete process.env['PI_KIT_MEAT_PROXY_PACKAGE'];
  delete process.env['PI_KIT_LEARN_PACKAGE'];
  db = new DatabaseService({ dataDir: join(base, 'data') });
  meta = new MetaRepository(db);
  pkg = new MeatProxyPackage(meta);
  // A test runner's sandbox has no native `import()`; the package's own file is imported the runner's way.
  pkg.importer = <T>(url: string) => import(/* @vite-ignore */ url) as Promise<T>;
});
afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

describe('the meat-proxy package ships with the app and is installed into pi once', () => {
  it('is a pi package: the pi key names the extension, and the files are there', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'pi-kit-meat-proxy', 'package.json'), 'utf8'));
    expect(manifest.name).toBe(MEAT_PROXY_PACKAGE);
    expect(manifest.keywords).toContain('pi-package');
    expect(manifest.pi.extensions).toEqual(['./extensions/meat-proxy.ts']);
    for (const file of FILES) expect(existsSync(join(ROOT, 'pi-kit-meat-proxy', file)), file).toBe(true);
  });

  it('adds the bundled folder to the user’s pi settings the first time, and pi lists it', async () => {
    expect(await pkg.installedDir()).toBeUndefined();
    expect(await pkg.ensureInstalled()).toBe('installed');
    expect(folders()).toEqual([meatDir]);
    expect(await pkg.installedDir()).toBe(meatDir);
  });

  it('installs next to @pi-kit/learn when both start at once: neither entry is lost', async () => {
    const learn = new LearnPackage(meta);
    expect(await Promise.all([learn.ensureInstalled(), pkg.ensureInstalled()])).toEqual(['installed', 'installed']);
    expect(folders().sort()).toEqual([learnDir, meatDir].sort());
    expect(await learn.installedDir()).toBe(learnDir);
    expect(await pkg.installedDir()).toBe(meatDir);
  });

  it('does nothing the second time, stays removed after `pi remove`, and does not touch the other package', async () => {
    const learn = new LearnPackage(meta);
    await learn.ensureInstalled();
    await pkg.ensureInstalled();
    const before = readFileSync(join(agent, 'settings.json'), 'utf8');
    expect(await pkg.ensureInstalled()).toBe('present');
    expect(readFileSync(join(agent, 'settings.json'), 'utf8')).toBe(before);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [learnDir] }));
    expect(await pkg.installedDir()).toBeUndefined();
    expect(await pkg.ensureInstalled()).toBe('removed-by-user');
    expect(settings().packages).toEqual([learnDir]);
    expect(await pkg.scoring()).toBeUndefined();
  });

  it('points a moved app at the copy it ships now', async () => {
    const old = join(base, 'old-app', 'packages', 'pi-kit-meat-proxy');
    ship('pi-kit-meat-proxy', FILES, old);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [old] }));
    expect(await pkg.installedDir()).toBe(old);
    rmSync(join(base, 'old-app'), { recursive: true, force: true });
    expect(await pkg.ensureInstalled()).toBe('repointed');
    expect(folders()).toEqual([meatDir]);
  });

  it('is skipped when the environment says so', async () => {
    process.env['PI_KIT_MEAT_PROXY_PACKAGE'] = 'off';
    expect(await pkg.ensureInstalled()).toBe('off');
    expect(existsSync(join(agent, 'settings.json'))).toBe(false);
  });

  it('loads the scoring of the installed copy: the same arithmetic the extension uses', async () => {
    await pkg.ensureInstalled();
    const scoring = await pkg.scoring();
    const labels = [
      { id: 'a@1:1', file: 'a', header: '@@', label: 'specified' as const, input: 'first-prompt' as const, trace: '', lines: 3, by: 'model' as const },
      { id: 'b@1:1', file: 'b', header: '@@', label: 'autonomous' as const, input: 'none' as const, trace: '', lines: 1, by: 'model' as const },
    ];
    expect(scoring?.computeScores(labels)).toMatchObject({ meat: 75, vibe: 25, line: '75 % steered: 1 of 2 hunks, 1 by the first prompt' });
    expect(scoring?.effectiveLabels({ labels, corrections: { 'b@1:1': { label: 'manual', was: 'autonomous', file: 'b', header: '@@', at: 1 } } })[1]).toMatchObject({ label: 'manual', by: 'person' });
    expect(typeof scoring?.scoreThread).toBe('function');
  });
});

describe('whether the package is installed decides whether anything of it is drawn', () => {
  it('follows pi’s settings: installed, then removed, then installed again; listeners hear every change', async () => {
    const heard: boolean[] = [];
    pkg.onInstalledChange((now) => heard.push(now));
    expect(await pkg.refresh()).toBe(false);
    await pkg.ensureInstalled();
    expect(await pkg.refresh()).toBe(true);
    expect(pkg.installedNow()).toBe(true);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [] }));
    expect(await pkg.refresh()).toBe(false);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [meatDir] }));
    expect(await pkg.refresh()).toBe(true);
    expect(heard).toEqual([true, false, true]);
  });
});
