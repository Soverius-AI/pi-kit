import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../worktree/worktree-git';
import {
  canonicalSkillSource,
  INSTALL_METADATA,
  installSkill,
  parseSkillManifest,
  previewSkill,
  SkillInstallConflict,
} from './skill-installer';

vi.mock('../worktree/worktree-git', () => ({ run: vi.fn() }));
const commit = 'a'.repeat(40);
let temp: string;
let fixture: string;
let agentDir: string;
let cwd: string;
let fetchDir: string;
const manifest = (name = 'example') =>
  `---\nname: ${name}\ndescription: |\n  A useful imported skill.\n---\nOriginal upstream content\n`;
async function file(path: string, content: string) {
  await mkdir(dirname(join(fixture, path)), { recursive: true });
  await writeFile(join(fixture, path), content);
}
const input = () => ({ source: 'owner/repo', name: 'example', scope: 'user' as const, agentDir, cwd });
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'installer-test-')));
  fixture = join(temp, 'fixture');
  agentDir = join(temp, 'agent');
  cwd = join(temp, 'project');
  await mkdir(fixture);
  fetchDir = '';
  vi.mocked(run).mockImplementation(async (dir, args) => {
    if (args.includes('clone')) {
      fetchDir = dir;
      await cp(fixture, args[args.length - 1], { recursive: true });
      await mkdir(join(args[args.length - 1], '.git'));
    }
    let stdout = '';
    if (args.includes('rev-parse')) stdout = commit;
    if (args.includes('ls-tree')) stdout = '100644 blob ' + commit + ' 10\tSKILL.md\0';
    return { ok: true, code: 0, stdout, stderr: '' };
  });
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(temp, { recursive: true, force: true });
});

describe('skill-only GitHub installer', () => {
  it('passes the configured Git timeout without changing fetch safety options', async () => {
    await file('SKILL.md', manifest());
    await installSkill(input(), { gitTimeoutMs: 1234 });
    for (const [, args, options] of vi.mocked(run).mock.calls) {
      expect(options?.timeoutMs).toBe(1234);
      expect(args).toContain('core.hooksPath=/dev/null');
      expect(args).toContain('protocol.allow=never');
    }
  });

  it('canonicalizes only strict public GitHub sources', () => {
    expect(canonicalSkillSource('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(canonicalSkillSource('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    for (const source of [
      'git@github.com:o/r',
      'http://github.com/o/r',
      'https://user@github.com/o/r',
      'o/r/../x',
      'o/r?token=x',
      'https://evil.test/o/r',
      'o/..',
      '-o/r',
    ])
      expect(() => canonicalSkillSource(source)).toThrow();
  });
  it('parses standard YAML independently of editor templates', () => {
    expect(parseSkillManifest(manifest()).name).toBe('example');
    expect(
      parseSkillManifest(
        manifest().replace('description: |', 'description: |-').replace('A useful imported skill.', 'x'.repeat(1024)),
      ).description.trim(),
    ).toHaveLength(1024);
    for (const text of [
      'no YAML',
      manifest('../bad'),
      manifest().replace('A useful imported skill.', 'x'.repeat(1025)),
      '---\nname: example\nname: duplicate\ndescription: test\n---\n',
    ])
      expect(() => parseSkillManifest(text)).toThrow();
  });
  it('copies complete nested skill content, licenses and provenance without rewriting upstream', async () => {
    await file('plugins/demo/skills/example/SKILL.md', manifest());
    await file('plugins/demo/skills/example/scripts/tool.sh', '#!/bin/sh\necho never-run');
    await file('LICENSE', 'Upstream license');
    await installSkill(input());
    const installed = join(agentDir, 'skills', 'example');
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe(manifest());
    expect(await readFile(join(installed, 'scripts/tool.sh'), 'utf8')).toContain('never-run');
    expect(await readFile(join(installed, 'LICENSE'), 'utf8')).toBe('Upstream license');
    expect(JSON.parse(await readFile(join(installed, INSTALL_METADATA), 'utf8'))).toEqual({
      source: 'https://github.com/owner/repo.git',
      commit,
      path: 'plugins/demo/skills/example',
    });
    expect(await readdir(join(agentDir, 'skills'))).toEqual(['example']);
    await expect(lstat(fetchDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const clone = vi.mocked(run).mock.calls.find(([, args]) => args.includes('clone'))!;
    expect(clone[1]).toContain('--no-checkout');
    expect(clone[1]).toContain('credential.helper=');
    expect(clone[2]).toMatchObject({ timeoutMs: 30000, env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(vi.mocked(run).mock.calls.some(([, args]) => args.includes('submodule'))).toBe(false);
  });
  it('supports repository-root skills and project scope', async () => {
    await file('SKILL.md', manifest());
    await installSkill({ ...input(), scope: 'project' });
    expect(await readFile(join(cwd, '.pi/skills/example/SKILL.md'), 'utf8')).toBe(manifest());
  });
  it('refuses existing empty destinations and dangling symlinks before fetch', async () => {
    const dest = join(agentDir, 'skills/example');
    await mkdir(dest, { recursive: true });
    await expect(installSkill(input())).rejects.toBeInstanceOf(SkillInstallConflict);
    await rm(dest, { recursive: true });
    await symlink(join(temp, 'missing'), dest);
    await expect(installSkill(input())).rejects.toBeInstanceOf(SkillInstallConflict);
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects symlinked destination ancestors', async () => {
    await mkdir(join(temp, 'outside'));
    await mkdir(agentDir);
    await symlink(join(temp, 'outside'), join(agentDir, 'skills'));
    await expect(installSkill(input())).rejects.toThrow('Unsafe destination ancestor');
    expect(run).not.toHaveBeenCalled();
  });
  it('ignores malformed unrelated manifests and templates but refuses a selected invalid manifest', async () => {
    await file('skills/example/SKILL.md', manifest());
    await file('skills/broken/SKILL.md', '---\nname: [invalid\n---\n');
    await file('templates/SKILL.md', '---\nname: <skill-name>\ndescription: template\n---\n');
    await installSkill(input());
    await rm(join(agentDir, 'skills/example'), { recursive: true });
    await file('skills/example/SKILL.md', '---\nname: example\ndescription: 123\n---\n');
    await expect(installSkill(input())).rejects.toThrow('Selected skill has invalid manifest');
  });
  it('canonicalizes trusted base aliases but refuses managed .pi aliases', async () => {
    await file('SKILL.md', manifest());
    await mkdir(agentDir);
    const alias = join(temp, 'base-alias');
    await symlink(agentDir, alias);
    await installSkill({ ...input(), agentDir: alias });
    expect(await readFile(join(agentDir, 'skills/example/SKILL.md'), 'utf8')).toBe(manifest());
    await mkdir(cwd);
    await symlink(agentDir, join(cwd, '.pi'));
    await expect(installSkill({ ...input(), scope: 'project' })).rejects.toThrow('Unsafe destination ancestor');
  });
  it('rejects duplicate selected names and cleans fetch and staging', async () => {
    await file('skills/example/SKILL.md', manifest());
    await file('.agents/skills/example/SKILL.md', manifest());
    await expect(installSkill(input())).rejects.toBeInstanceOf(SkillInstallConflict);
    expect(await readdir(join(agentDir, 'skills'))).toEqual([]);
    await expect(lstat(fetchDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects mismatched folders, reserved metadata and symlinks', async () => {
    await file('wrong/SKILL.md', manifest());
    await expect(installSkill(input())).rejects.toThrow('match its folder');
    await rm(join(fixture, 'wrong'), { recursive: true });
    await file('SKILL.md', manifest());
    await file(INSTALL_METADATA, 'untrusted');
    await expect(installSkill(input())).rejects.toThrow('reserved');
    await rm(join(fixture, INSTALL_METADATA));
    await symlink('/etc/passwd', join(fixture, 'unsafe'));
    await expect(installSkill(input())).rejects.toThrow('unsafe');
  });
  it('rejects unsafe git tree modes and oversized objects before checkout', async () => {
    for (const tree of [
      `120000 blob ${commit} 10\tlink\0`,
      `160000 commit ${commit} -\tsubmodule\0`,
      `100644 blob ${commit} 1073741825\tlarge\0`,
      `100644 blob ${commit} 1\t../escape\0`,
    ]) {
      vi.mocked(run).mockImplementation(async (dir, args) => {
        if (args.includes('clone')) {
          const repo = args[args.length - 1];
          await mkdir(join(repo, '.git'), { recursive: true });
        }
        return {
          ok: true,
          code: 0,
          stderr: '',
          stdout: args.includes('rev-parse') ? commit : args.includes('ls-tree') ? tree : '',
        };
      });
      await expect(installSkill(input())).rejects.toThrow();
    }
    expect(vi.mocked(run).mock.calls.some(([, args]) => args.includes('checkout'))).toBe(false);
  });
  it('accepts a collection over the old 100 MB limit when the selected skill is small', async () => {
    await file('skills/example/SKILL.md', manifest());
    const original = vi.mocked(run).getMockImplementation()!;
    vi.mocked(run).mockImplementation(async (dir, args, options) => {
      const result = await original(dir, args, options);
      return args.includes('ls-tree')
        ? { ...result, stdout: `100644 blob ${commit} 209715200\tunrelated-asset\0` }
        : result;
    });
    await installSkill(input());
    expect(await readFile(join(agentDir, 'skills/example/SKILL.md'), 'utf8')).toBe(manifest());
  });
  it('serializes same-destination installs without overwriting', async () => {
    await file('SKILL.md', manifest());
    const results = await Promise.allSettled([installSkill(input()), installSkill(input())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('cleans failed fetches and releases reservation', async () => {
    vi.mocked(run).mockResolvedValue({ ok: false, code: 1, stdout: '', stderr: 'private repository' });
    await expect(installSkill(input())).rejects.toThrow('public GitHub');
    await expect(installSkill(input())).rejects.toThrow('public GitHub');
    expect(await readdir(join(agentDir, 'skills'))).toEqual([]);
  });
});

describe('safe skill metadata previews', () => {
  it('reads selected real metadata and counts the exact install payload without managed writes', async () => {
    const text =
      '---\nname: example\ndescription: Real description\nlicense: MIT\ncompatibility: Requires a shell\nmetadata:\n  author: Upstream Author\nallowed-tools: Bash\n---\n# Plain upstream markdown\n';
    await file('skills/example/SKILL.md', text);
    await file('skills/example/scripts/check.sh', 'never execute me');
    await file('LICENSE', 'Repository license');
    await file('unrelated.txt', 'not in payload');
    const detail = await previewSkill({ source: 'owner/preview-metadata.git', name: 'example' });
    expect(detail).toMatchObject({
      source: 'owner/preview-metadata',
      name: 'example',
      description: 'Real description',
      license: 'MIT',
      compatibility: 'Requires a shell',
      author: 'Upstream Author',
      path: 'skills/example',
      commit,
      files: 3,
      bytes: Buffer.byteLength(text + 'never execute me' + 'Repository license'),
      scripts: ['scripts/check.sh'],
      content: text,
    });
    expect(detail.warnings.join(' ')).toContain('environment/tool-specific');
    await expect(lstat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(fetchDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.mocked(run).mock.calls.every(([, args]) => !args.includes('check.sh'))).toBe(true);
  });

  it('omits invalid optional metadata, bounds content/scripts and ignores unrelated broken manifests', async () => {
    await file(
      'SKILL.md',
      '---\nname: example\ndescription: valid\nlicense: [MIT]\ncompatibility: 42\nmetadata:\n  author: {name: bad}\n---\n' +
        'x'.repeat(41000),
    );
    await file('broken/SKILL.md', '---\nname: [invalid\n---\n');
    for (let i = 0; i < 22; i++) await file(`scripts/task-${i}.sh`, 'echo x');
    const detail = await previewSkill({ source: 'owner/preview-bounded', name: 'example' });
    expect(detail).toMatchObject({ path: '.', files: 24 });
    expect(detail.license).toBeUndefined();
    expect(detail.compatibility).toBeUndefined();
    expect(detail.author).toBeUndefined();
    expect(detail.content).toHaveLength(40000);
    expect(detail.scripts).toHaveLength(20);
    expect(detail.warnings.join(' ')).toContain('truncated');
    expect(detail.warnings.join(' ')).toContain('Invalid license');
  });

  it('deduplicates and caches bounded metadata without retaining a checkout or sharing mutable results', async () => {
    await file('SKILL.md', manifest());
    const request = { source: 'owner/preview-cache', name: 'example' };
    const [first, second] = await Promise.all([previewSkill(request), previewSkill(request)]);
    first.warnings.push('caller mutation');
    expect(second.warnings).toEqual([]);
    const third = await previewSkill(request);
    expect(third.warnings).toEqual([]);
    expect(vi.mocked(run).mock.calls.filter(([, args]) => args.includes('clone'))).toHaveLength(1);
    await expect(lstat(fetchDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the configured preview cache lifetime and capacity', async () => {
    await file('SKILL.md', manifest());
    const options = { previewCacheMs: 10, previewCacheEntries: 1 };
    const request = { source: 'owner/configured-cache', name: 'example' };
    await previewSkill(request, options);
    await previewSkill(request, options);
    expect(vi.mocked(run).mock.calls.filter(([, args]) => args.includes('clone'))).toHaveLength(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11);
    try {
      await previewSkill(request, options);
      await previewSkill({ ...request, source: 'owner/configured-cache-other' }, options);
      await previewSkill(request, options);
      expect(vi.mocked(run).mock.calls.filter(([, args]) => args.includes('clone'))).toHaveLength(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('allows only two concurrent temporary checkouts and expires cached metadata after two minutes', async () => {
    await file('SKILL.md', manifest());
    const original = vi.mocked(run).getMockImplementation()!;
    const releases: Array<() => void> = [];
    vi.mocked(run).mockImplementation(async (dir, args, options) => {
      if (args.includes('clone')) await new Promise<void>((ready) => releases.push(ready));
      return original(dir, args, options);
    });
    const requests = [0, 1, 2].map((i) => ({ source: `owner/preview-concurrency-${i}`, name: 'example' }));
    const pending = requests.map((request) => previewSkill(request));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]();
    releases[2]();
    await Promise.all(pending);
    vi.mocked(run).mockImplementation(original);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
    try {
      await previewSkill(requests[0]);
      expect(vi.mocked(run).mock.calls.filter(([, args]) => args.includes('clone'))).toHaveLength(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('cleans selected malformed previews and does not cache failures', async () => {
    await file('SKILL.md', '---\nname: example\ndescription: 123\n---\n');
    const request = { source: 'owner/preview-malformed', name: 'example' };
    await expect(previewSkill(request)).rejects.toThrow('Selected skill has invalid manifest');
    await expect(lstat(fetchDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await file('SKILL.md', manifest());
    await expect(previewSkill(request)).resolves.toMatchObject({ name: 'example' });
  });

  it('fetches and validates an explicitly pinned commit instead of installing newer HEAD', async () => {
    await file('SKILL.md', manifest());
    const pinned = 'b'.repeat(40);
    const original = vi.mocked(run).getMockImplementation()!;
    vi.mocked(run).mockImplementation(async (dir, args, options) => {
      const result = await original(dir, args, options);
      if (args.includes('rev-parse') && args.includes('FETCH_HEAD')) result.stdout = pinned;
      return result;
    });
    await installSkill({ ...input(), commit: pinned });
    const calls = vi.mocked(run).mock.calls.map(([, args]) => args);
    expect(
      calls.some(
        (args) => args.includes('fetch') && args.slice(-2).join(' ') === `https://github.com/owner/repo.git ${pinned}`,
      ),
    ).toBe(true);
    expect(calls.find((args) => args.includes('ls-tree'))).toContain(pinned);
    expect(calls.find((args) => args.includes('checkout'))).toContain(pinned);
    expect(JSON.parse(await readFile(join(agentDir, 'skills/example', INSTALL_METADATA), 'utf8')).commit).toBe(pinned);
  });

  it('rejects invalid pins before fetching or creating managed directories and mismatched fetches before checkout', async () => {
    await expect(installSkill({ ...input(), commit: '--unsafe' })).rejects.toThrow('Invalid requested commit');
    expect(run).not.toHaveBeenCalled();
    await expect(lstat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await file('SKILL.md', manifest());
    await expect(installSkill({ ...input(), commit: 'c'.repeat(40) })).rejects.toThrow('does not match');
    expect(vi.mocked(run).mock.calls.some(([, args]) => args.includes('checkout'))).toBe(false);
    await expect(lstat(fetchDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
