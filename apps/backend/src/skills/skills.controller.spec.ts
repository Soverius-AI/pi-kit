import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stampProvenance } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import type { PiSessionService } from '../pi/pi-session.service';
import type { TrustService } from '../pi/trust.service';
import { readSkill } from './managed-skills';
import { installSkill, previewSkill, SkillInstallConflict } from './skill-installer';
import { SkillCatalog } from './skills-search';
import { SkillsController } from './skills.controller';

vi.mock('./skill-installer', () => ({
  installSkill: vi.fn(),
  previewSkill: vi.fn(),
  SkillInstallConflict: class extends Error {},
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(trusted = true) {
  const root = mkdtempSync(join(tmpdir(), 'pk-skill-controller-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const sessions = { agentDir: vi.fn().mockResolvedValue(agentDir), reloadIdleSessions: vi.fn().mockResolvedValue(2) };
  const trust = { folderTrusted: vi.fn().mockResolvedValue(trusted) };
  const config: BackendConfig = {
    defaultCwd: cwd,
    dataDir: root,
    token: 'test-token',
    port: 1234,
    host: '127.0.0.1',
    origins: [],
    dev: false,
  };
  const controller = new SkillsController(
    sessions as unknown as PiSessionService,
    trust as unknown as TrustService,
    config,
    new SkillCatalog(config.skills),
  );
  return { controller, sessions, trust, agentDir, cwd, config };
}

function writeSkill(input: { name: string; scope: 'user' | 'project'; agentDir: string; cwd: string }) {
  const root = input.scope === 'user' ? join(input.agentDir, 'skills') : join(input.cwd, '.pi', 'skills');
  const folder = join(root, input.name);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  writeFileSync(path, `---\nname: ${input.name}\ndescription: Use when testing skills\n---\nInstructions\n`);
  return readSkill(path, input.agentDir, input.cwd);
}

describe('skill routes', () => {
  it('retains read access and modified times, refusing unrelated paths', async () => {
    const s = setup();
    const file = writeSkill({ name: 'read-me', scope: 'user', agentDir: s.agentDir, cwd: s.cwd });
    expect(await s.controller.read({ path: file.path })).toEqual(file);
    await expect(s.controller.read({ path: join(s.cwd, 'auth.json') })).rejects.toMatchObject({ status: 400 });
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
  });

  it('maps learned-skill deletion to a conflict without reloading', async () => {
    const s = setup();
    const file = writeSkill({ name: 'learned', scope: 'user', agentDir: s.agentDir, cwd: s.cwd });
    writeFileSync(file.path, stampProvenance(file.text, { learnedFrom: 'thread-id', base: 'abc', head: 'def' }));
    await expect(s.controller.remove({ path: file.path }, { mtime: file.mtime })).rejects.toMatchObject({
      status: 409,
    });
    expect(readSkill(file.path, s.agentDir, s.cwd).text).toContain('learnedFrom: thread-id');
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
  });
  it('delegates search to the injected catalog and passes installer configuration', async () => {
    const s = setup();
    s.config.skills = { gitTimeoutMs: 1234, previewCacheMs: 500 };
    await s.controller.detail({ source: 'org/repo', name: 'test' });
    expect(previewSkill).toHaveBeenCalledWith({ source: 'org/repo', name: 'test' }, s.config.skills);
    const catalog = new SkillCatalog({ offline: true });
    const controller = new SkillsController(
      s.sessions as unknown as PiSessionService,
      s.trust as unknown as TrustService,
      s.config,
      catalog,
    );
    expect(await controller.search({ q: 'angular' })).toMatchObject({ error: expect.stringContaining('offline') });
  });
  it('previews real metadata without installation or reload, and respects offline mode', async () => {
    const s = setup();
    const preview = {
      source: 'org/repo',
      name: 'test',
      description: 'Real description',
      path: 'skills/test',
      commit: 'a'.repeat(40),
      files: 1,
      bytes: 100,
      scripts: [],
      content: 'instructions',
      warnings: [],
    };
    vi.mocked(previewSkill).mockResolvedValueOnce(preview);
    expect(await s.controller.detail({ source: 'org/repo', name: 'test' })).toEqual(preview);
    expect(installSkill).not.toHaveBeenCalled();
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
    s.config.skills = { offline: true };
    await expect(s.controller.detail({ source: 'org/repo', name: 'test' })).rejects.toMatchObject({ status: 400 });
    expect(previewSkill).toHaveBeenCalledTimes(1);
  });
  it('installs user skills and reloads idle sessions after success', async () => {
    const s = setup();
    vi.mocked(installSkill).mockResolvedValueOnce(undefined);
    expect(
      await s.controller.install({}, { source: 'angular/skills', name: 'angular-developer', scope: 'user' }),
    ).toEqual({ message: 'Installed angular-developer.', reloaded: 2 });
    expect(installSkill).toHaveBeenCalledWith(
      { source: 'angular/skills', name: 'angular-developer', scope: 'user', agentDir: s.agentDir, cwd: s.cwd },
      undefined,
    );
    expect(s.trust.folderTrusted).not.toHaveBeenCalled();
  });

  it('refuses untrusted project installation and offline installation before fetching', async () => {
    const s = setup(false);
    await expect(
      s.controller.install({}, { source: 'angular/skills', name: 'angular-developer', scope: 'project' }),
    ).rejects.toMatchObject({ status: 409 });
    s.config.skills = { offline: true };
    await expect(
      s.controller.install({}, { source: 'angular/skills', name: 'angular-developer', scope: 'user' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(installSkill).not.toHaveBeenCalled();
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
  });

  it('maps destination conflicts without reloading', async () => {
    const s = setup();
    vi.mocked(installSkill).mockRejectedValueOnce(new SkillInstallConflict('Already installed.'));
    await expect(
      s.controller.install({}, { source: 'angular/skills', name: 'angular-developer', scope: 'user' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
  });

  it('deletes only a trusted, unchanged managed skill and reloads after success', async () => {
    const s = setup();
    const file = writeSkill({ name: 'delete-me', scope: 'project', agentDir: s.agentDir, cwd: s.cwd });
    await expect(s.controller.remove({ path: file.path }, { mtime: file.mtime - 1 })).rejects.toMatchObject({
      status: 409,
    });
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
    expect(await s.controller.remove({ path: file.path }, { mtime: file.mtime })).toEqual({
      message: 'Deleted delete-me.',
      reloaded: 2,
    });
    expect(() => readSkill(file.path, s.agentDir, s.cwd)).toThrow(/gone/);
  });

  it('refuses untrusted project deletion and arbitrary paths', async () => {
    const s = setup(false);
    const file = writeSkill({ name: 'keep-me', scope: 'project', agentDir: s.agentDir, cwd: s.cwd });
    await expect(s.controller.remove({ path: file.path }, { mtime: file.mtime })).rejects.toMatchObject({
      status: 409,
    });
    await expect(s.controller.remove({ path: join(s.cwd, 'auth.json') }, { mtime: 0 })).rejects.toMatchObject({
      status: 400,
    });
    expect(readSkill(file.path, s.agentDir, s.cwd).name).toBe('keep-me');
    expect(s.sessions.reloadIdleSessions).not.toHaveBeenCalled();
  });
});
