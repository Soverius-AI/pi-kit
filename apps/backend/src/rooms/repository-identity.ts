import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MetaRepository } from '../db/meta.repository';
import { refExists, run, toplevel, trackedChanges } from '../worktree/worktree-git';

export class RepositoryIdentity {
  static normalize(remote: string): string {
    return remote
      .trim()
      .replace(/^[a-z+]+:\/\//i, '')
      .replace(/^[^@/]+@/, '')
      .replace(/:(?!\d)/, '/')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
  }

  static async of(folder: string): Promise<{ root: string; repository: string } | undefined> {
    const root = await toplevel(folder);
    if (!root) return undefined;
    const origin = await run(root, ['remote', 'get-url', 'origin']);
    return {
      root,
      repository: origin.ok && origin.stdout.trim() ? RepositoryIdentity.normalize(origin.stdout) : basename(root),
    };
  }

  static async findClone(meta: MetaRepository, repository: string, base: string): Promise<string | undefined> {
    return (await RepositoryIdentity.clones(meta, repository, base))[0]?.folder;
  }

  static async clones(meta: MetaRepository, repository: string, base: string): Promise<RepositoryClone[]> {
    const found = new Map<string, RepositoryClone>();
    for (const workspace of await meta.listWorkspaces()) {
      const identity = await RepositoryIdentity.of(workspace.cwd).catch(() => undefined);
      if (!identity || identity.repository !== repository || found.has(identity.root)) continue;
      if (RepositoryIdentity.linkedWorktree(identity.root) || !(await refExists(identity.root, base))) continue;
      found.set(identity.root, {
        folder: identity.root,
        clean: (await trackedChanges(identity.root).catch(() => 1)) === 0,
        lastOpenedAt: workspace.lastOpenedAt,
      });
    }
    return [...found.values()].sort(
      (a, b) =>
        Number(b.clean) - Number(a.clean) || b.lastOpenedAt - a.lastOpenedAt || a.folder.localeCompare(b.folder),
    );
  }

  private static linkedWorktree(root: string): boolean {
    try {
      return statSync(join(root, '.git')).isFile();
    } catch {
      return false;
    }
  }
}

export interface RepositoryClone {
  folder: string;
  clean: boolean;
  lastOpenedAt: number;
}
