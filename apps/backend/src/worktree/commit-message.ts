import { basename } from 'node:path';

/** One changed file as `git status` reports it: the badge letter of `libs/protocol` file-badges (A, M, D, U, C, R). */
export interface ChangedPath {
  path: string;
  badge: 'A' | 'M' | 'D' | 'U' | 'C' | 'R';
}

const SUBJECT_MAX = 72;
const LIST_MAX = 20;

const verb = (badge: ChangedPath['badge']): string => ({ A: 'Add', U: 'Add', D: 'Remove', R: 'Rename', M: 'Update', C: 'Resolve' })[badge];
const word = (badge: ChangedPath['badge']): string => ({ A: 'added', U: 'added', D: 'removed', R: 'renamed', M: 'modified', C: 'conflicted' })[badge];

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  return `${head.slice(0, Math.max(20, head.lastIndexOf(' ')))}…`;
}

/**
 * The commit message pi-kit proposes for a worktree's uncommitted changes (Merge back dialog; the person edits it). The subject is the thread's
 * title when it has one, else a sentence about the files; the body lists every file with what happened to it. Deterministic: no model call.
 */
export function generateCommitMessage(options: { title?: string | null; files: readonly ChangedPath[] }): string {
  const files = options.files;
  if (files.length === 0) return options.title?.trim() ? cut(options.title.trim(), SUBJECT_MAX) : 'Update';
  const names = files.map((f) => basename(f.path));
  let subject: string;
  if (options.title?.trim()) {
    subject = cut(options.title.trim().replace(/\s+/g, ' '), SUBJECT_MAX);
  } else if (files.length === 1) {
    subject = `${verb(files[0].badge)} ${names[0]}`;
  } else {
    const kinds = new Set(files.map((f) => verb(f.badge)));
    const lead = kinds.size === 1 ? [...kinds][0] : 'Update';
    subject = names.length <= 3 ? `${lead} ${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : `${lead} ${names.slice(0, 2).join(', ')} and ${names.length - 2} more files`;
  }
  const lines = files.slice(0, LIST_MAX).map((f) => `- ${word(f.badge)} ${f.path}`);
  if (files.length > LIST_MAX) lines.push(`- and ${files.length - LIST_MAX} more files`);
  return `${cut(subject, SUBJECT_MAX)}\n\n${lines.join('\n')}`;
}

/** The merge commit's message when a thread's branch is merged into the base. */
export function mergeCommitMessage(branch: string, base: string, title?: string | null): string {
  const head = `Merge ${branch} into ${base}`;
  return title?.trim() ? `${head}\n\n${cut(title.trim().replace(/\s+/g, ' '), 200)}` : head;
}
