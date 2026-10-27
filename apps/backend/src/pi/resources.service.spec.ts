import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResourcesService } from './resources.service';
import type { TrustService } from './trust.service';
import type { DesktopBridge } from '../desktop/desktop-bridge';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('./load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

/** A scratch agent folder and project, and a trust service that answers as the test says. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-resources-')));
  const agent = join(base, 'agent');
  const project = join(base, 'project');
  mkdirSync(join(agent, 'extensions'), { recursive: true });
  writeFileSync(join(agent, 'extensions', 'user-ext.ts'), 'export default function () {}\n');
  mkdirSync(join(agent, 'skills', 'user-skill'), { recursive: true });
  writeFileSync(join(agent, 'skills', 'user-skill', 'SKILL.md'), '---\nname: user-skill\ndescription: A skill from the agent folder\n---\n\nDo it.\n');
  mkdirSync(join(project, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(project, '.pi', 'extensions', 'project-ext.ts'), 'export default function () {}\n');
  mkdirSync(join(project, '.pi', 'prompts'), { recursive: true });
  writeFileSync(join(project, '.pi', 'prompts', 'review.md'), '---\ndescription: Review the change\n---\n\nReview $@\n');
  return { base, agent, project };
}

const trusting = (status: 'trusted' | 'untrusted'): TrustService => ({ state: async () => ({ cwd: '', hasResources: true, status, source: 'saved', resources: [] }) }) as unknown as TrustService;

describe('the extension, skill and prompt inventory', () => {
  const w = world();
  const previous = process.env['PI_CODING_AGENT_DIR'];
  beforeAll(() => {
    process.env['PI_CODING_AGENT_DIR'] = w.agent;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
  });

  it('lists what pi discovers in both scopes with where it came from', async () => {
    const overview = await new ResourcesService(trusting('trusted')).overview(w.project);
    const byName = (type: string, name: string) => overview.items.find((i) => i.type === type && i.name === name);
    expect(byName('extensions', 'user-ext')).toMatchObject({ scope: 'user', enabled: true, origin: 'top-level' });
    expect(byName('extensions', 'project-ext')).toMatchObject({ scope: 'project', enabled: true });
    expect(byName('skills', 'user-skill')).toMatchObject({ scope: 'user', description: 'A skill from the agent folder' });
    expect(byName('prompts', 'review')).toMatchObject({ scope: 'project', description: 'Review the change' });
    expect(byName('extensions', 'project-ext')?.label).toMatch(/^Project/);
    expect(overview.projectCwd).toBe(w.project);
    expect(overview.projectSkipped).toBe(false);
  });

  it('writes a -path entry the way pi config does, and a +path entry to turn it on again', async () => {
    const service = new ResourcesService(trusting('trusted'));
    const key = (await service.overview(w.project)).items.find((i) => i.name === 'user-ext')!.key;
    const off = await service.toggle(w.project, key, false);
    expect(off.items.find((i) => i.name === 'user-ext')?.enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(w.agent, 'settings.json'), 'utf8')).extensions).toEqual(['-extensions/user-ext.ts']);
    const on = await service.toggle(w.project, key, true);
    expect(on.items.find((i) => i.name === 'user-ext')?.enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(w.agent, 'settings.json'), 'utf8')).extensions).toEqual(['+extensions/user-ext.ts']);
  });

  it('writes a project item into the folder’s own settings', async () => {
    const service = new ResourcesService(trusting('trusted'));
    const key = (await service.overview(w.project)).items.find((i) => i.name === 'project-ext')!.key;
    await service.toggle(w.project, key, false);
    expect(JSON.parse(readFileSync(join(w.project, '.pi', 'settings.json'), 'utf8')).extensions).toEqual(['-extensions/project-ext.ts']);
  });

  it('does not list project resources of a folder that is not trusted', async () => {
    const overview = await new ResourcesService(trusting('untrusted')).overview(w.project);
    expect(overview.items.some((i) => i.scope === 'project')).toBe(false);
    expect(overview.projectSkipped).toBe(true);
    expect(overview.items.some((i) => i.name === 'user-ext')).toBe(true);
  });

  it('refuses a resource pi no longer lists', async () => {
    await expect(new ResourcesService(trusting('trusted')).toggle(w.project, 'extensions:user:top-level:local:/gone.ts', true)).rejects.toThrow(/no longer lists/);
  });

  it('lists the shipped browser skill only with desktop capability', async () => {
    const service = new ResourcesService(trusting('trusted'), { available: true } as DesktopBridge);
    const skill = (await service.overview(w.project)).items.find((item) => item.name === 'pi-browser');
    expect(skill).toMatchObject({ type: 'skills', enabled: true, origin: 'builtin', label: 'Bundled with pi-kit' });
    expect(readFileSync(skill!.path, 'utf8')).toContain('pi_browser');
    await expect(service.toggle(w.project, skill!.key, false)).rejects.toThrow(/desktop browser availability/);
    expect((await new ResourcesService(trusting('trusted')).overview(w.project)).items.some((item) => item.name === 'pi-browser')).toBe(false);
  });

  it('lists the built-in UI skill for web and desktop sessions', async () => {
    const service = new ResourcesService(trusting('trusted'));
    const skill = (await service.overview(w.project)).items.find((item) => item.name === 'pi-ui');
    expect(skill).toMatchObject({ enabled: true, origin: 'builtin', type: 'skills' });
    expect(readFileSync(skill!.path, 'utf8')).toContain('generateSandboxedUi');
    await expect(service.toggle(w.project, skill!.key, false)).rejects.toThrow(/built-in UI tools/);
  });
});
