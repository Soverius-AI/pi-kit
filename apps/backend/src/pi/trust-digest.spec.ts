import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trustDigest } from './trust-scan';
import { TrustService } from './trust.service';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('./load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-digest-')));
  mkdirSync(join(base, 'agent'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(base, 'agent'));
  vi.stubEnv('PI_KIT_TRUSTED_CWDS', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

function project(name: string, extension = 'export default () => {};\n', mcp = '{"mcpServers":{}}'): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
  mkdirSync(join(dir, '.pi', 'skills', 'pdf'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'extensions', 'hello.ts'), extension);
  writeFileSync(join(dir, '.pi', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n');
  writeFileSync(join(dir, '.pi', 'mcp.json'), mcp);
  writeFileSync(join(dir, 'README.md'), name);
  return dir;
}

/** A trust service for which `worktree` is a thread worktree of `main`, answered "once" for `main` only. */
async function trustOf(main: string, worktree: string): Promise<TrustService> {
  const trust = new TrustService();
  trust.useWorktrees((path) => (path === worktree ? main : undefined));
  await trust.decide(main, 'once');
  return trust;
}

describe('trustDigest', () => {
  it('is the same for two folders that hold the same project resources, whatever else differs', async () => {
    expect(await trustDigest(project('main'))).toBe(await trustDigest(project('worktree')));
  });

  it('changes when an extension, a skill or the mcp.json differs', async () => {
    const main = await trustDigest(project('main'));
    expect(await trustDigest(project('a', 'export default () => { run(); };\n'))).not.toBe(main);
    expect(await trustDigest(project('b', undefined, '{"mcpServers":{"x":{}}}'))).not.toBe(main);
    const c = project('c');
    writeFileSync(join(c, '.pi', 'skills', 'pdf', 'SKILL.md'), 'changed');
    expect(await trustDigest(c)).not.toBe(main);
  });

  it('is what makes a thread worktree inherit the project’s trust, until its own resources differ', async () => {
    const main = project('main');
    const worktree = project('worktree');
    const trust = await trustOf(main, worktree);
    expect(await trust.folderTrusted(worktree)).toBe(true);
    // A folder that is no worktree of anything answers for itself, however alike its resources.
    expect(await trust.folderTrusted(project('twin'))).toBe(false);
    writeFileSync(join(worktree, '.pi', 'extensions', 'hello.ts'), 'export default () => { exfiltrate(); };\n');
    expect(await trust.folderTrusted(worktree)).toBe(false);
  });

  it.each(['extension inventory', 'directory inventory', 'large file', 'hidden dependency'])('does not inherit trust after an edit beyond the old %s cutoff', async (scenario) => {
    const main = project('main');
    const worktree = project('worktree');
    let changed = '';
    for (const root of [main, worktree]) {
      const extensions = join(root, '.pi', 'extensions');
      if (scenario === 'extension inventory') {
        for (let i = 0; i < 13; i++) writeFileSync(join(extensions, `extra${String(i).padStart(2, '0')}.ts`), 'original');
        changed = '.pi/extensions/extra12.ts';
      } else {
        mkdirSync(join(extensions, 'tools'));
        if (scenario === 'directory inventory') {
          for (let i = 0; i < 401; i++) writeFileSync(join(extensions, 'tools', `${String(i).padStart(3, '0')}.ts`), 'original');
          changed = '.pi/extensions/tools/400.ts';
        } else {
          changed = `.pi/extensions/tools/${scenario === 'large file' ? 'large.ts' : '.config'}`;
          writeFileSync(join(root, changed), scenario === 'large file' ? Buffer.alloc(2 * 1024 * 1024 + 1, 'a') : 'original');
        }
      }
    }
    const trust = await trustOf(main, worktree);
    expect(await trust.folderTrusted(worktree)).toBe(true);
    // The same size as before: only the bytes tell.
    writeFileSync(join(worktree, changed), scenario === 'large file' ? Buffer.alloc(2 * 1024 * 1024 + 1, 'b') : 'modified');
    expect(await trust.folderTrusted(worktree)).toBe(false);
  });

  it('is stable for a folder without resources', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const empty = join(base, 'empty');
    mkdirSync(join(empty, '.pi'), { recursive: true });
    expect(await trustDigest(plain)).toBe(await trustDigest(empty));
  });

  it('does not inherit trust when a resource directory loops back through a symlink', async () => {
    const main = project('main');
    const worktree = project('worktree');
    for (const root of [main, worktree]) {
      const extensions = join(root, '.pi', 'extensions');
      symlinkSync(extensions, join(extensions, 'loop'), 'dir');
    }
    const trust = await trustOf(main, worktree);
    expect(await trust.folderTrusted(worktree)).toBe(false);
  });
});
