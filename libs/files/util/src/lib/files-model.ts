import type { Translate } from '@pi-kit/i18n';
import {
  type FileNode,
  type FileStatusEntry,
  type GitBadge,
  GIT_BADGES,
  type WorkspaceStatus,
  folderBadges,
} from '@pi-kit/protocol';
import type { PkMenuItem } from '@pi-kit/ui';

/**
 * The Files panel's model: what a row shows (badge, thread marker, folder dot, size and time), the flat list
 * the keyboard walks, type-ahead, what Enter does and which entries the context menu offers. Pure and tested; the panel only draws it.
 */

export interface FileDecoration {
  /** git's badge for the file, if it is changed. */
  badge?: GitBadge;
  /** `Modified`, `Added`, ...; the badge's title. */
  badgeLabel?: string;
  tone?: 'success' | 'warning' | 'error' | 'info';
  staged?: boolean;
  /** pi edited or wrote the file in this thread: a marker apart from the git badge. */
  thread: boolean;
  /** A folder with changes inside: a dot in the colour of the worst badge. */
  dot?: GitBadge;
  /** Where a renamed file came from. */
  from?: string;
}

/** Looks up decorations for paths from the status the backend sent. */
export function decorator(status: WorkspaceStatus | undefined): (path: string, dir: boolean) => FileDecoration {
  const files = new Map<string, FileStatusEntry>((status?.entries ?? []).map((e) => [e.path, e]));
  const thread = new Set(status?.thread ?? []);
  const dots = folderBadges(status?.entries ?? []);
  return (path, dir) => {
    if (dir) {
      const dot = dots.get(path);
      return { thread: false, ...(dot ? { dot } : {}) };
    }
    const entry = files.get(path);
    const info = entry && GIT_BADGES[entry.badge];
    return {
      thread: thread.has(path),
      ...(entry && info
        ? {
            badge: entry.badge,
            badgeLabel: info.label,
            tone: info.tone,
            staged: entry.staged,
            ...(entry.from ? { from: entry.from } : {}),
          }
        : {}),
    };
  };
}

/** A file git or the thread knows to be changed. */
export const isChanged = (d: FileDecoration): boolean => d.badge !== undefined || d.thread;

/** `340 B`, `4.1 kB`, `1.2 MB`. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} kB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

const monthNames = (translate: Translate) => [
  translate('files.filesModel.jan'),
  translate('files.filesModel.feb'),
  translate('files.filesModel.mar'),
  translate('files.filesModel.apr'),
  translate('files.filesModel.may'),
  translate('files.filesModel.jun'),
  translate('files.filesModel.jul'),
  translate('files.filesModel.aug'),
  translate('files.filesModel.sep'),
  translate('files.filesModel.oct'),
  translate('files.filesModel.nov'),
  translate('files.filesModel.dec'),
];

/** Today as a clock time, this year as `Oct 15`, older as `2024-03-01`. */
export function formatMtime(translate: Translate, ms: number | undefined, now = Date.now()): string {
  if (ms === undefined) return '';
  const date = new Date(ms);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.getFullYear() === today.getFullYear()) return `${monthNames(translate)[date.getMonth()]} ${date.getDate()}`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export interface FileRow {
  node: FileNode;
  depth: number;
}

/** The rows in view, in order, for the keyboard: folders that are open show their children. */
export function visibleRows(
  children: ReadonlyMap<string, FileNode[]>,
  expanded: ReadonlySet<string>,
  dir = '',
  depth = 0,
): FileRow[] {
  const out: FileRow[] = [];
  for (const node of children.get(dir) ?? []) {
    out.push({ node, depth });
    if (node.dir && expanded.has(node.path)) out.push(...visibleRows(children, expanded, node.path, depth + 1));
  }
  return out;
}

/**
 * Type-ahead: the next row (after `from`, wrapping) whose name starts with `buffer`, ignoring case. Typing the same letter again
 * cycles through the rows that start with it, as file managers do.
 */
export function typeAhead(rows: readonly FileRow[], from: number, buffer: string): number {
  const q = buffer.toLowerCase();
  if (!q || rows.length === 0) return -1;
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0] : q;
  const start = from >= 0 ? from + (q.length === 1 || repeated ? 1 : 0) : 0;
  for (let i = 0; i < rows.length; i++) {
    const at = (start + i) % rows.length;
    if (rows[at].node.name.toLowerCase().startsWith(needle)) return at;
  }
  return -1;
}

/** What Enter does on a row: a folder opens or closes, a changed file opens its diff, anything else inserts `@path`. */
export function enterAction(node: Pick<FileNode, 'dir'>, decoration: FileDecoration): 'toggle' | 'diff' | 'mention' {
  if (node.dir) return 'toggle';
  return isChanged(decoration) ? 'diff' : 'mention';
}

export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Why a name typed into "New file" or "Rename" cannot be used, or `undefined`. */
export function nameProblem(translate: Translate, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return translate('files.filesModel.typeAName');
  if (trimmed.startsWith('/') || trimmed.split('/').some((part) => part === '..' || part === '.' || part === ''))
    return translate('files.filesModel.useANameOrAPathInside');
  if (trimmed.split('/')[0] === '.git') return translate('files.filesModel.theGitFolderIsGitSOwn');
  return undefined;
}

export interface MenuContext {
  /** The row's file is changed in git or the thread. */
  decoration: FileDecoration;
  /** A thread is open, so revert and diff have somewhere to go. */
  hasThread: boolean;
  /** The file is not on the disk any more (a deletion git still shows). */
  missing?: boolean;
  /** The desktop app is running (reveal and open need it); the browser answers with a toast, so they stay enabled. */
  composerAvailable: boolean;
}

/** The context menu of a row. */
export function menuItems(translate: Translate, node: Pick<FileNode, 'dir'>, ctx: MenuContext): PkMenuItem[] {
  const changed = !node.dir && ctx.decoration.badge !== undefined;
  const gone = !!ctx.missing;
  const items: PkMenuItem[] = [
    { id: 'open', label: translate('files.filesModel.openInEditor'), disabled: node.dir || gone },
    { id: 'reveal', label: translate('files.filesModel.revealInFinder'), disabled: gone },
    { id: 'copy-path', label: translate('files.filesModel.copyPath'), separatorBefore: true },
    { id: 'copy-relative', label: translate('files.filesModel.copyRelativePath') },
    { id: 'mention', label: translate('files.filesModel.addToMessage'), hint: '@', disabled: !ctx.composerAvailable },
    { id: 'new-file', label: translate('files.filesModel.newFile'), separatorBefore: true },
    { id: 'new-folder', label: translate('files.filesModel.newFolder') },
    { id: 'rename', label: translate('files.filesModel.rename'), disabled: gone },
    { id: 'delete', label: translate('files.filesModel.delete'), danger: true, disabled: gone },
  ];
  if (changed && ctx.hasThread) {
    items.push({ id: 'diff', label: translate('files.filesModel.openDiff'), separatorBefore: true });
    items.push({
      id: 'revert',
      label:
        ctx.decoration.badge === 'U'
          ? translate('files.filesModel.revertDeleteNewFile')
          : translate('files.filesModel.revert'),
      danger: true,
    });
  }
  return items;
}

/** The text of the confirmation before a revert. */
export function revertWords(translate: Translate, badge: GitBadge | undefined): string {
  switch (badge) {
    case 'U':
      return translate('files.filesModel.isNotInGitYetSoReverting');
    case 'A':
      return translate('files.filesModel.wasAddedToGitAndNotCommitted');
    case 'D':
      return translate('files.filesModel.isDeletedAndComesBackAsGit');
    default:
      return translate('files.filesModel.goesBackToHowGitSHEAD');
  }
}
