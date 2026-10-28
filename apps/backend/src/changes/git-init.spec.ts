import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStatusController } from './workspace-status.controller';

describe('POST /workspaces/:id/git-init', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pk-git-init-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // Only the workspace lookup is used by this endpoint.
  const controller = (cwd: string) =>
    new WorkspaceStatusController(undefined as never, { requireWorkspace: () => cwd } as never);

  it('makes a plain folder a git repository', async () => {
    expect(await controller(base).initGit('w')).toEqual({ git: true });
    expect(existsSync(join(base, '.git'))).toBe(true);
  });

  it('leaves a folder alone that is already inside a work tree (no nested repository)', async () => {
    execFileSync('git', ['init', '-q'], { cwd: base });
    const sub = join(base, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    expect(await controller(sub).initGit('w')).toEqual({ git: true });
    expect(existsSync(join(sub, '.git'))).toBe(false);
  });
});
