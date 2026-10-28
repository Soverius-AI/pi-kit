import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FileStatus } from '@pi-kit/protocol';
import { git } from '../changes/git';
import { SKIP_DIRS } from '../workspace/ignore';

/** How often a shadow repository is cleaned at most; a tree nobody asked for in this long is gone after the next clean. */
const GC_EVERY_MS = 24 * 60 * 60_000;
const PRUNE = '30.days.ago';
/** An untracked file bigger than this is left out of snapshots (a dataset or a video nobody ignored), like opencode does. */
export const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
/** At most this many big files are named to leave out in one capture (the command line has a limit). */
const MAX_LEFT_OUT = 2000;

/** What every opening of one shadow repository shares: commands run one at a time on its index. */
interface Shared {
  queue: Promise<unknown>;
  lastGc: number;
  /** Creating the repository, while it runs: it happens once, however many folders of the project open it at the same time. */
  creating?: Promise<void>;
}

/** The shadow repositories of one process and what their openings share. One per app (`RunSnapshotsService`), so their lifetime is its. */
export class ShadowRegistry {
  private readonly states = new Map<string, Shared>();

  stateOf(dir: string): Shared {
    let state = this.states.get(dir);
    if (!state) this.states.set(dir, (state = { queue: Promise.resolve(), lastGc: 0 }));
    return state;
  }
}

export interface FileChange {
  /** Relative to the folder the repository was opened for. */
  path: string;
  status: FileStatus;
  /** `null`: git says the file is binary. */
  added: number | null;
  removed: number | null;
}

/**
 * A private git repository that records snapshots of a project folder as trees, outside the folder: in `<dataDir>/snapshots`, one per
 * repository. It borrows the project's objects (`objects/info/alternates`), keeps its own index, and never touches the project's `.git`:
 * every command runs with `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` pointing at it. Snapshots are trees without refs or commits;
 * an unused tree is pruned 30 days after it was written. Dependency folders and caches (`SKIP_DIRS`) are never recorded, and the
 * project's ignore rules apply as they do for `git add`; untracked files over `MAX_UNTRACKED_BYTES` are left out. A folder that is not in a git
 * work tree has none (`open` answers `undefined`). Every folder of one repository shares its shadow repository and the one queue of its index.
 */
export class ShadowRepo {
  private constructor(
    /** The repository's top level, the work tree of the commands that write; `undefined` for a repository only read (its folder is gone). */
    private readonly top: string | undefined,
    /** The folder inside it that paths are relative to (`''` for the top level), with a trailing `/`. */
    private readonly prefix: string,
    private readonly dir: string,
    private readonly shared: Shared,
    /** Makes the repository (again) when it is missing. */
    private readonly ensure: () => Promise<void>,
  ) {}

  static async open(folder: string, dataDir: string, registry: ShadowRegistry): Promise<ShadowRepo | undefined> {
    let top: string;
    let prefix: string;
    let gitDir: string;
    let commonDir: string;
    try {
      const out = (
        await git(folder, ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir', '--git-common-dir'])
      ).split('\n');
      [top, prefix, gitDir] = [out[0].trim(), out[1].trim(), out[2].trim()];
      commonDir = isAbsolute(out[3].trim()) ? out[3].trim() : resolve(folder, out[3].trim());
    } catch {
      return undefined;
    }
    if (!top) return undefined;
    const dir = join(dataDir, 'snapshots', createHash('sha1').update(top).digest('hex').slice(0, 16));
    const state = registry.stateOf(dir);
    // Checked before every command too: a shadow repository deleted while the app runs is made again.
    const ensure = async (): Promise<void> => {
      if (!existsSync(join(dir, 'HEAD')))
        state.creating ??= create(dir, gitDir, commonDir).finally(() => (state.creating = undefined));
      await state.creating;
    };
    await ensure();
    return new ShadowRepo(top, prefix ? `${prefix.replace(/\/$/, '')}/` : '', dir, state, ensure);
  }

  /**
   * A shadow repository known by where it is (`location`), for reading what its snapshots hold after the folder it recorded is gone (a worktree
   * merged back and removed): it compares trees, it cannot capture or restore.
   */
  static stored(location: { dir: string; prefix: string }, registry: ShadowRegistry): ShadowRepo | undefined {
    if (!existsSync(join(location.dir, 'HEAD'))) return undefined;
    return new ShadowRepo(
      undefined,
      location.prefix,
      location.dir,
      registry.stateOf(location.dir),
      async () => undefined,
    );
  }

  /** Where the repository is and which folder of the project its paths are relative to: kept with each run, so `stored` can find it. */
  get location(): { dir: string; prefix: string } {
    return { dir: this.dir, prefix: this.prefix };
  }

  /** Records the folder as it is now; returns the tree. */
  capture(): Promise<string> {
    return this.serial(async () => {
      const scope = this.prefix || '.';
      const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z', '--', scope]))
        .split('\0')
        .filter(Boolean);
      const big = (await bigFiles(this.writable(), untracked)).slice(0, MAX_LEFT_OUT);
      await this.git(['add', '-A', '--', scope, ...big.map((path) => `:(exclude,literal)${path}`)], { timeout: 0 });
      const tree = (await this.git(['write-tree'])).trim();
      if (Date.now() - this.shared.lastGc > GC_EVERY_MS) {
        this.shared.lastGc = Date.now();
        void this.serial(() => this.git(['gc', '-q', `--prune=${PRUNE}`], { timeout: 0 })).catch(() => undefined);
      }
      return tree;
    });
  }

  /** The files that differ between two trees under the folder, optionally only `paths`, with their line counts: one `git diff --raw --numstat`. */
  async changes(from: string, to: string, paths?: readonly string[]): Promise<FileChange[]> {
    if (from === to || paths?.length === 0) return [];
    const out = await this.read([
      'diff',
      '--raw',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      `--relative=${this.prefix}`,
      from,
      to,
      '--',
      ...this.pathspecs(paths),
    ]);
    // `-z`: each raw entry is `:<modes> <hashes> <letter>` then the path; after them each numstat entry is `<added>\t<removed>\t<path>`.
    const tokens = out.split('\0');
    const status = new Map<string, FileStatus>();
    const counts = new Map<string, { added: number | null; removed: number | null }>();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith(':')) {
        const letter = token.slice(-1);
        status.set(tokens[++i], letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M');
        continue;
      }
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(token);
      if (match)
        counts.set(
          match[3],
          match[1] === '-' ? { added: null, removed: null } : { added: Number(match[1]), removed: Number(match[2]) },
        );
    }
    return [...status].map(([path, letter]) => ({
      path,
      status: letter,
      ...(counts.get(path) ?? { added: 0, removed: 0 }),
    }));
  }

  /** The unified diff of one file between two trees (three lines of context). */
  patch(from: string, to: string, path: string): Promise<string> {
    return this.read([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      `--relative=${this.prefix}`,
      '-U3',
      from,
      to,
      '--',
      `:(literal)${this.prefix}${path}`,
    ]);
  }

  /**
   * Puts `path` back as `tree` has it; a file the tree does not have is deleted. Throws, and touches nothing, when the tree itself is gone (pruned
   * after 30 days): "not in the snapshot" must never be guessed from a snapshot that cannot be read.
   */
  restore(tree: string, path: string): Promise<void> {
    return this.serial(async () => {
      const top = this.writable();
      const full = this.prefix + path;
      await this.read(['cat-file', '-e', `${tree}^{tree}`]).catch((error: unknown) => {
        throw new Error(`The snapshot ${tree} is gone.`, { cause: error });
      });
      const listed = await this.read(['ls-tree', '--name-only', '-z', tree, '--', full]);
      if (listed.split('\0').includes(full))
        await this.git(['checkout', tree, '--', `:(literal)${full}`], { timeout: 0 });
      else rmSync(join(top, full), { force: true });
    });
  }

  private pathspecs(paths?: readonly string[]): string[] {
    return paths ? paths.map((path) => `:(literal)${this.prefix}${path}`) : [this.prefix || '.'];
  }

  /** A command on the work tree and the index (capture, restore). */
  private git(args: readonly string[], options: { timeout?: number } = {}): Promise<string> {
    const top = this.writable();
    return git(top, args, {
      ...options,
      env: { GIT_DIR: this.dir, GIT_WORK_TREE: top, GIT_INDEX_FILE: join(this.dir, 'index') },
    });
  }

  /** A command that only reads objects: it runs in the repository itself, so it works when the recorded folder is gone. */
  private read(args: readonly string[]): Promise<string> {
    return git(this.dir, args, { env: { GIT_DIR: this.dir } });
  }

  private writable(): string {
    if (!this.top) throw new Error('This snapshot repository can only be read: the folder it recorded is gone.');
    return this.top;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensure();
      // Every command on this index waits its turn in the shared queue: a lock left here is from a process that died.
      rmSync(join(this.dir, 'index.lock'), { force: true });
      return work();
    };
    const next = this.shared.queue.then(run, run);
    this.shared.queue = next.catch(() => undefined);
    return next;
  }
}

async function create(dir: string, gitDir: string, commonDir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '--bare', '-q', '.'], { timeout: 0 });
  for (const [key, value] of [
    ['core.bare', 'false'],
    ['core.autocrlf', 'false'],
    ['core.fsmonitor', 'false'],
    ['core.untrackedCache', 'true'],
    // A split index (below) is joined into one file when the shadow first writes it.
    ['core.splitIndex', 'false'],
    ['gc.auto', '0'],
  ])
    await git(dir, ['config', key, value], { timeout: 0 });
  mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
  writeFileSync(join(dir, 'objects', 'info', 'alternates'), `${join(commonDir, 'objects')}\n`);
  const skipped = [...SKIP_DIRS].filter((name) => name !== '.git').map((name) => `${name}/`);
  const own = join(commonDir, 'info', 'exclude');
  mkdirSync(join(dir, 'info'), { recursive: true });
  writeFileSync(
    join(dir, 'info', 'exclude'),
    [...skipped, existsSync(own) ? readFileSync(own, 'utf8') : ''].join('\n'),
  );
  // The project's index as a start: its stat data spares hashing every tracked file in the first snapshot. A split index (`core.splitIndex`)
  // needs its shared part too, or git cannot read it.
  if (existsSync(join(gitDir, 'index'))) {
    copyFileSync(join(gitDir, 'index'), join(dir, 'index'));
    for (const name of readdirSync(gitDir).filter((entry) => entry.startsWith('sharedindex.')))
      copyFileSync(join(gitDir, name), join(dir, name));
  }
}

/** The untracked files over `MAX_UNTRACKED_BYTES`, a few stats at a time. */
async function bigFiles(top: string, paths: readonly string[]): Promise<string[]> {
  const big: string[] = [];
  let next = 0;
  const work = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++];
      const stat = await lstat(join(top, path)).catch(() => undefined);
      if (stat && stat.size > MAX_UNTRACKED_BYTES) big.push(path);
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, paths.length) }, work));
  return big;
}
