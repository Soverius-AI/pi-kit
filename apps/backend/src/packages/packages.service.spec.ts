import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackagesService, latestOverrides } from './packages.service';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

/**
 * The service over pi's real package manager, in a scratch agent folder: a package is installed from a folder (nothing is downloaded), listed, switched, updated and removed; the
 * search runs against a registry on loopback that answers with the recorded fixture.
 */
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'npm-search.json'), 'utf8');

let base: string;
let agent: string;
let project: string;
let pkg: string;
let service: PackagesService;
let reloads: number;
let trusted: boolean;
let registry: Server;
let registryUrl: string;
let searches: string[];
const saved: Record<string, string | undefined> = {};
const KEYS = ['PI_CODING_AGENT_DIR', 'PI_KIT_NPM_REGISTRY', 'PI_KIT_PACKAGE_LATEST', 'PI_OFFLINE', 'PI_KIT_LEARN_PACKAGE_DIR', 'PI_KIT_MEAT_PROXY_PACKAGE_DIR'];

function writePackage(dir: string, version: string): void {
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'split-task'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo-pkg', version, description: 'A demo package', keywords: ['pi-package'] }, null, 2));
  writeFileSync(join(dir, 'extensions', 'hello.ts'), 'export default function () {}\n');
  writeFileSync(join(dir, 'skills', 'split-task', 'SKILL.md'), '---\nname: split-task\ndescription: Split a task\n---\n\nDo it.\n');
  writeFileSync(join(dir, 'prompts', 'review.md'), '---\ndescription: Review\n---\n\nReview $@\n');
  writeFileSync(join(dir, 'README.md'), '# Demo package\n\nIt says hello.\n');
}

beforeAll(async () => {
  registry = createServer((req, res) => {
    searches.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if ((req.url ?? '').startsWith('/-/v1/search')) res.end(FIXTURE);
    else if (req.url === '/pi-subagents') res.end(JSON.stringify({ name: 'pi-subagents', 'dist-tags': { latest: '0.5.0' }, readme: 'The sub-agents README.', versions: { '0.5.0': { name: 'pi-subagents', version: '0.5.0', description: 'Sub-threads', license: 'MIT', pi: { extensions: ['./a.ts'], skills: ['./skills'] } } } }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
  registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => registry.close(() => done())));

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-packages-')));
  agent = join(base, 'agent');
  project = join(base, 'project');
  pkg = join(base, 'demo-pkg');
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  writePackage(pkg, '0.1.0');
  process.env['PI_CODING_AGENT_DIR'] = agent;
  process.env['PI_KIT_NPM_REGISTRY'] = registryUrl;
  delete process.env['PI_KIT_PACKAGE_LATEST'];
  delete process.env['PI_OFFLINE'];
  // The packages that ship with the app, found where this checkout keeps them.
  process.env['PI_KIT_LEARN_PACKAGE_DIR'] = resolve(__dirname, '..', '..', '..', '..', 'packages', 'pi-kit-learn');
  process.env['PI_KIT_MEAT_PROXY_PACKAGE_DIR'] = resolve(__dirname, '..', '..', '..', '..', 'packages', 'pi-kit-meat-proxy');
  reloads = 0;
  trusted = true;
  searches = [];
  const sessions = { reloadIdleSessions: async () => ++reloads && 1 };
  const trust = { state: async () => ({ status: trusted ? 'trusted' : 'untrusted' }), folderTrusted: async () => trusted };
  const updates = { packageUpdates: async () => [] };
  service = new PackagesService(sessions as never, trust as never, updates as never, { defaultCwd: project } as never);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const settings = (): { packages?: unknown[] } => JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'));

describe('install and list', () => {
  it('installs a package from a folder into pi’s settings, reloads the threads, and lists what it brings', async () => {
    const result = await service.install(project, { source: pkg });
    expect(settings().packages).toHaveLength(1);
    expect(result.message).toBe('Installed demo-pkg 0.1.0. 1 open thread reloaded.');
    expect(reloads).toBe(1);
    const [item] = result.overview.packages;
    expect(item.id).toBe(`user:${item.source}`);
    expect(item).toMatchObject({ name: 'demo-pkg', version: '0.1.0', description: 'A demo package', scope: 'user', origin: 'folder', enabled: true, installed: true, path: pkg });
    expect(item.brings).toMatchObject({ extensions: 1, skills: 1, prompts: 1, themes: 0, names: { extensions: ['hello'], skills: ['split-task'], prompts: ['review'] } });
    expect(item.installedAt).toBeUndefined();
  });

  it('lists nothing for a clean agent folder', async () => {
    expect(await service.list(project)).toEqual({ packages: [], errors: [] });
  });

  it('refuses the same package twice, a folder that is not a package, and a source pi cannot install', async () => {
    await service.install(project, { source: pkg });
    await expect(service.install(project, { source: pkg })).rejects.toThrow(/installed already/);
    const empty = join(base, 'empty');
    mkdirSync(empty);
    await expect(service.install(project, { source: empty })).rejects.toThrow(/not a pi package/);
    await expect(service.install(project, { source: join(base, 'missing') })).rejects.toThrow(/does not exist/);
    await expect(service.install(project, { source: 'npm:' })).rejects.toThrow(/npm:name/);
    await expect(service.install(project, { source: 'git:nowhere' })).rejects.toThrow(/repository address/);
    expect(settings().packages).toHaveLength(1);
  });

  it('a project install needs a trusted folder, and goes into the folder’s own settings', async () => {
    trusted = false;
    await expect(service.install(project, { source: pkg, scope: 'project' })).rejects.toThrow(/not trusted/);
    trusted = true;
    const result = await service.install(project, { source: pkg, scope: 'project' });
    expect(result.overview.packages[0]).toMatchObject({ scope: 'project', path: pkg });
    expect(JSON.parse(readFileSync(join(project, '.pi', 'settings.json'), 'utf8')).packages).toHaveLength(1);
    expect(existsSettings()).toBe(false);
  });
});

function existsSettings(): boolean {
  try {
    return (settings().packages ?? []).length > 0;
  } catch {
    return false;
  }
}

describe('switch, update, remove', () => {
  it('off keeps the package and counts what it brings; on gives the entry back as the source alone', async () => {
    const { overview } = await service.install(project, { source: pkg });
    const id = overview.packages[0].id;
    const off = await service.setEnabled(project, id, false);
    expect(off.packages[0]).toMatchObject({ enabled: false, brings: { extensions: 1, skills: 1, prompts: 1 } });
    expect(settings().packages?.[0]).toMatchObject({ extensions: [], skills: [], prompts: [], themes: [] });
    const on = await service.setEnabled(project, id, true);
    expect(on.packages[0].enabled).toBe(true);
    expect(typeof settings().packages?.[0]).toBe('string');
  });

  it('removes a package and reloads', async () => {
    const { overview } = await service.install(project, { source: pkg });
    const before = reloads;
    const result = await service.remove(project, overview.packages[0].id);
    expect(result.message).toBe('Removed demo-pkg.');
    expect(result.overview.packages).toEqual([]);
    expect(settings().packages ?? []).toEqual([]);
    expect(reloads).toBe(before + 1);
    await expect(service.remove(project, 'user:gone')).rejects.toThrow(/does not list/);
  });

  it('a check marks a package with a newer version (the test hook), and an update clears it', async () => {
    const { overview } = await service.install(project, { source: pkg });
    process.env['PI_KIT_PACKAGE_LATEST'] = JSON.stringify({ 'demo-pkg': '0.2.0' });
    const checked = await service.outdated(project);
    expect(checked.packages[0].outdated).toEqual({ current: '0.1.0', latest: '0.2.0' });
    expect(checked.checkedAt).toBeGreaterThan(0);
    expect((await service.list(project)).packages[0].outdated).toEqual({ current: '0.1.0', latest: '0.2.0' });
    // the folder is the package: a new version in it is what "update" picks up
    writePackage(pkg, '0.2.0');
    const updated = await service.update(project, overview.packages[0].id);
    expect(updated.message).toBe('Updated demo-pkg 0.1.0 → 0.2.0.');
    expect(updated.overview.packages[0].outdated).toBeUndefined();
  });

  it('latestOverrides is for development only', () => {
    expect(latestOverrides({ PI_KIT_PACKAGE_LATEST: '{"a":"1.0.0"}' })).toEqual({ a: '1.0.0' });
    expect(latestOverrides({ PI_KIT_PACKAGE_LATEST: '{"a":"1.0.0"}', NODE_ENV: 'production' })).toEqual({});
    expect(latestOverrides({ PI_KIT_PACKAGE_LATEST: 'nope' })).toEqual({});
  });
});

describe('search', () => {
  it('lists the registry’s packages and pi-kit’s own, marks what is installed, and caches', async () => {
    const first = await service.search('', undefined, project);
    expect(first.error).toBeUndefined();
    expect(first.results.map((r) => r.name)).toEqual(['@pi-kit/learn', '@pi-kit/meat-proxy', '@pi-kit/computer-use', 'pi-subagents', 'pi-swarm', '@devops/skills-devops', 'pi-review-bot']);
    expect(first.results[0]).toMatchObject({ bundled: true, version: '0.1.0', exact: true, contains: ['extensions'] });
    expect(first.total).toBe(9);
    await service.search('', undefined, project);
    expect(searches).toHaveLength(1);
    await service.install(project, { source: first.results[0].source });
    const after = await service.search('', undefined, project);
    expect(after.results.find((r) => r.name === '@pi-kit/learn')?.installed).toBe(true);
    expect(after.results.find((r) => r.name === 'pi-swarm')?.installed).toBe(false);
  });

  it('puts the query in the registry search and filters pi-kit’s own by it', async () => {
    const result = await service.search('subagent', undefined, project);
    expect(decodeURIComponent(searches[0])).toContain('keywords:pi-package subagent');
    expect(result.results.map((r) => r.name)).not.toContain('@pi-kit/learn');
    expect((await service.search('learn', undefined, project)).results[0].name).toBe('@pi-kit/learn');
  });

  it('filters by what a package contains', async () => {
    expect((await service.search('', 'skills', project)).results.map((r) => r.name)).toEqual(['pi-subagents', '@devops/skills-devops']);
    expect((await service.search('', 'themes', project)).results).toEqual([]);
  });

  it('a registry that does not answer leaves the pi-kit packages and says why', async () => {
    process.env['PI_KIT_NPM_REGISTRY'] = 'http://127.0.0.1:1';
    const result = await service.search('', undefined, project);
    expect(result.error).toMatch(/Could not reach the registry/);
    expect(result.error).toMatch(/ship with pi-kit/);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.bundled)).toBe(true);
  });
});

describe('detail', () => {
  it('a folder: name, version, what it adds, the README and the command', async () => {
    const detail = await service.detail(pkg, project);
    expect(detail).toMatchObject({ origin: 'folder', name: 'demo-pkg', version: '0.1.0', description: 'A demo package', installed: false, command: `pi install ${pkg}` });
    expect(detail.brings).toMatchObject({ extensions: 1, skills: 1, prompts: 1 });
    expect(detail.readme).toContain('It says hello.');
  });

  it('an npm package: the document of the registry with its README and its pi key', async () => {
    const detail = await service.detail('npm:pi-subagents', project);
    expect(detail).toMatchObject({ origin: 'npm', name: 'pi-subagents', version: '0.5.0', license: 'MIT', readme: 'The sub-agents README.', command: 'pi install npm:pi-subagents' });
    expect(detail.brings).toMatchObject({ extensions: 1, skills: 1 });
    expect(detail.notes).toEqual([]);
  });

  it('a registry without the package still gives the command, and says so', async () => {
    const detail = await service.detail('npm:nothing-here@1.0.0', project);
    expect(detail).toMatchObject({ origin: 'npm', name: 'nothing-here', command: 'pi install npm:nothing-here@1.0.0' });
    expect(detail.notes[0]).toMatch(/registry answered 404/);
  });

  it('a git repository: the name and the command, and no guess at what it adds', async () => {
    const detail = await service.detail('git:gitlab.com/x/tools', project);
    expect(detail).toMatchObject({ origin: 'git', name: 'tools', command: 'pi install git:gitlab.com/x/tools' });
    expect(detail.brings).toBeUndefined();
    expect(detail.notes.join(' ')).toMatch(/known once pi has cloned/);
  });

  it('says a folder is installed once it is', async () => {
    await service.install(project, { source: pkg });
    expect((await service.detail(pkg, project)).installed).toBe(true);
  });
});
