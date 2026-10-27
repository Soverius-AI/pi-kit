import { createHash } from 'node:crypto';
import { parsePatch } from 'diff';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { FAIL_SCORE, PASS_SCORE, REPRODUCED_THRESHOLD, type TranscriptCheck, type VerificationResult, type VerifiedFile, parseSkillText } from '@pi-kit/protocol';
import { branchOf } from '../attendant/attendant-text';

/**
 * The rules of a verification, pure so they are tested without git, pi or a model: reading a unified diff, the similarity of two diffs by file and by
 * hunk, the verdict, which of the original thread's checks are run again, and what the replay is given (the first prompt, the model).
 *
 * **Similarity.** A diff is read with no context lines (`git diff -U0`), so a hunk is a run of changed lines and nothing else. Two sets of changed lines are compared with the Dice
 * coefficient over their lines as multisets: `2 * |common| / (|a| + |b|)`, where a line is `-text` or `+text` (trailing blanks ignored). One means the same lines were added and removed; zero means nothing
 * in common. A file counts as *reproduced* when its changed lines are at least `REPRODUCED_THRESHOLD` similar, and so does a hunk (matched one to one, best match first). The whole diff is
 * compared the same way, with each line tagged by its file, for the score.
 */

export interface DiffHunk {
  removed: string[];
  added: string[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  /** A binary file is compared by the blob it ends with. */
  binary: string | null;
  /** The new mode of a file whose mode changed. */
  mode: string | null;
}

const trimEnd = (line: string): string => line.replace(/[ \t\r]+$/, '');

/** Reads Git's unified diff, including C-quoted paths. Unreadable nonempty output cannot become a passing empty outcome. */
export function parseDiff(text: string): FileDiff[] {
  return text.split(/(?=^diff --git )/m).filter((section) => section.trim()).map((section) => {
    const parsed = parsePatch(section);
    const patch = parsed[0];
    const path = patch?.newFileName === '/dev/null' ? patch.oldFileName : patch?.newFileName;
    if (parsed.length !== 1 || !patch.isGit || !path) throw new Error('The verification diff could not be read completely.');
    // jsdiff owns filenames and hunks. Git's final blob identity and executable-mode change remain comparison facts.
    const binary = /^Binary files .* differ$|^GIT binary patch$/m.test(section);
    const blob = /^index [0-9a-f]+\.\.([0-9a-f]+)/m.exec(section)?.[1];
    return {
      path: path.replace(/^[ab]\//, ''),
      binary: binary ? blob ?? 'binary' : null,
      mode: /^new mode (\d+)/m.exec(section)?.[1] ?? null,
      hunks: patch.hunks.map((hunk) => ({
        removed: hunk.lines.filter((line) => line.startsWith('-')).map((line) => trimEnd(line.slice(1))),
        added: hunk.lines.filter((line) => line.startsWith('+')).map((line) => trimEnd(line.slice(1))),
      })),
    };
  });
}

const hunkLines = (hunk: DiffHunk): string[] => [...hunk.removed.map((l) => `-${l}`), ...hunk.added.map((l) => `+${l}`)];

/** The changed lines of a file as a bag; a binary file is one line (its blob), a mode change one more. */
export function fileLines(file: FileDiff): string[] {
  return [...(file.binary ? [`binary:${file.binary}`] : []), ...(file.mode ? [`mode:${file.mode}`] : []), ...file.hunks.flatMap(hunkLines)];
}

/** Dice coefficient of two bags of lines; 1 when both are empty. */
export function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      common += 1;
      counts.set(line, left - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

export interface Comparison {
  files: VerifiedFile[];
  /** Files of the outcome the replay reproduced. */
  reproduced: number;
  expected: number;
  /** Files the replay touched that the outcome did not. */
  extra: number;
  hunks: { matched: number; expected: number; actual: number };
  /** Similarity of the whole diff, 0 to 1. */
  score: number;
}

/** Matches the hunks of two versions of a file one to one, best match first, and counts those that are at least `REPRODUCED_THRESHOLD` alike. */
function matchHunks(expected: readonly DiffHunk[], actual: readonly DiffHunk[]): number {
  const pairs: { e: number; a: number; sim: number }[] = [];
  expected.forEach((e, ei) => actual.forEach((a, ai) => pairs.push({ e: ei, a: ai, sim: dice(hunkLines(e), hunkLines(a)) })));
  pairs.sort((x, y) => y.sim - x.sim || x.e - y.e || x.a - y.a);
  const usedExpected = new Set<number>();
  const usedActual = new Set<number>();
  let matched = 0;
  for (const pair of pairs) {
    if (pair.sim < REPRODUCED_THRESHOLD) break;
    if (usedExpected.has(pair.e) || usedActual.has(pair.a)) continue;
    usedExpected.add(pair.e);
    usedActual.add(pair.a);
    matched += 1;
  }
  return matched;
}

/** What the outcome changed against what the replay changed, by file and by hunk, and the score of the whole. */
export function compareDiffs(expected: readonly FileDiff[], actual: readonly FileDiff[]): Comparison {
  const byPath = new Map(actual.map((f) => [f.path, f]));
  const files: VerifiedFile[] = [];
  let reproduced = 0;
  let matchedHunks = 0;
  let expectedHunks = 0;
  const expectedBag: string[] = [];
  const actualBag: string[] = [];
  const unitCount = (f: FileDiff): number => (f.binary || f.mode ? 1 : 0) + f.hunks.length;
  const units = (f: FileDiff): DiffHunk[] => [...(f.binary ? [{ removed: [], added: [`binary:${f.binary}`] }] : []), ...(f.mode ? [{ removed: [], added: [`mode:${f.mode}`] }] : []), ...f.hunks];
  for (const e of expected) {
    const a = byPath.get(e.path);
    byPath.delete(e.path);
    const eUnits = units(e);
    expectedHunks += eUnits.length;
    expectedBag.push(...fileLines(e).map((l) => `${e.path}\0${l}`));
    if (!a) {
      files.push({ path: e.path, status: 'missing', similarity: 0, hunks: { matched: 0, expected: unitCount(e), actual: 0 } });
      continue;
    }
    actualBag.push(...fileLines(a).map((l) => `${a.path}\0${l}`));
    const similarity = dice(fileLines(e), fileLines(a));
    const aUnits = units(a);
    const matched = matchHunks(eUnits, aUnits);
    matchedHunks += matched;
    const isReproduced = similarity >= REPRODUCED_THRESHOLD;
    if (isReproduced) reproduced += 1;
    files.push({ path: e.path, status: isReproduced ? (similarity === 1 ? 'same' : 'similar') : 'different', similarity, hunks: { matched, expected: eUnits.length, actual: aUnits.length } });
  }
  let actualHunks = files.reduce((n, f) => n + f.hunks.actual, 0);
  let extra = 0;
  for (const a of byPath.values()) {
    extra += 1;
    actualHunks += unitCount(a);
    actualBag.push(...fileLines(a).map((l) => `${a.path}\0${l}`));
    files.push({ path: a.path, status: 'extra', similarity: 0, hunks: { matched: 0, expected: 0, actual: unitCount(a) } });
  }
  return { files, reproduced, expected: expected.length, extra, hunks: { matched: matchedHunks, expected: expectedHunks, actual: actualHunks }, score: dice(expectedBag, actualBag) };
}

export interface CheckResultFacts {
  originalPassed: boolean;
  state: 'passed' | 'failed' | 'skipped';
}

/**
 * The verdict. `failed`: nothing of the outcome was reproduced, or the whole diff is below `FAIL_SCORE` alike. `pass`: every file reproduced, the whole diff at least `PASS_SCORE` alike, and no
 * check that passed in the original thread fails now (a check that failed then and fails again, or was skipped, does not count against the skill). Anything between is `partial`.
 */
export function verdict(comparison: Pick<Comparison, 'reproduced' | 'expected' | 'score'>, checks: readonly CheckResultFacts[]): VerificationResult {
  if (comparison.expected > 0 && (comparison.reproduced === 0 || comparison.score < FAIL_SCORE)) return 'failed';
  const regressed = checks.some((c) => c.originalPassed && c.state === 'failed');
  if (comparison.reproduced === comparison.expected && comparison.score >= PASS_SCORE && !regressed) return 'pass';
  return 'partial';
}

export interface PlannedCheck {
  command: string;
  originalPassed: boolean;
  /** Why the command is not run again. */
  skip?: string;
}

/**
 * The checks to run again: the shell commands the original thread ran that looked like a test run, a build, a type check or a linter (`TranscriptCheck`), each command once with the outcome
 * of its last run, oldest first. A command is listed but not run when the transcript masked a secret in it or when it names a folder of the original thread by
 * its absolute path (it would run there, not in the scratch worktree).
 */
export function planChecks(checks: readonly TranscriptCheck[], originalFolders: readonly string[]): PlannedCheck[] {
  const latest = new Map<string, TranscriptCheck>();
  for (const check of [...checks].sort((a, b) => a.step - b.step)) {
    latest.delete(check.command);
    latest.set(check.command, check);
  }
  const folders = originalFolders.filter((f) => f.length > 1).map((f) => f.replace(/\/+$/, ''));
  return [...latest.values()]
    .map((check) => {
      const planned: PlannedCheck = { command: check.command, originalPassed: check.passed };
      if (/\[redacted/i.test(check.command)) planned.skip = 'It held a secret that was masked, so it cannot be run as it was.';
      else if (folders.some((folder) => check.command.includes(folder))) planned.skip = 'It names the original folder by its absolute path, so it would run there.';
      return planned;
    });
}

// ---- what the replay is given

interface Block {
  type?: string;
  text?: string;
  provider?: string;
  model?: string;
}
interface Message {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
};

/** The `<skill …>…</skill>` blocks pi puts in front of a message that used a skill chip. */
const SKILL_BLOCKS = /<skill\b[^>]*>[\s\S]*?<\/skill>\s*/g;

/** The thread's first prompt as the person wrote it: the first user message of the branch, without the skill blocks a chip added. Empty when there is none. */
export function firstPromptOf(entries: readonly PiSessionEntry[], leafId: string | null): string {
  for (const entry of branchOf(entries, leafId)) {
    if (entry.type !== 'message') continue;
    const message = entry['message'] as Message | undefined;
    if (message?.role !== 'user') continue;
    const text = textOf(message.content).replace(SKILL_BLOCKS, '').trim();
    if (text) return text;
  }
  return '';
}

/** The model the thread last answered with (`provider/id`), if its session says. */
export function modelOfSession(entries: readonly PiSessionEntry[], leafId: string | null): { provider: string; modelId: string } | undefined {
  let found: { provider: string; modelId: string } | undefined;
  for (const entry of branchOf(entries, leafId)) {
    if (entry.type !== 'message') continue;
    const message = entry['message'] as Message | undefined;
    if (message?.role === 'assistant' && message.provider && message.model) found = { provider: message.provider, modelId: message.model };
  }
  return found;
}

/** A hash of a skill text without its provenance block: what "the skill that was verified" means, so that an edit afterwards is noticed. */
export function skillHash(text: string): string {
  const { lines, body, frontmatter } = parseSkillText(text);
  if (!frontmatter) return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith('x-pi-kit:')) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\s+\S/.test(line)) continue;
    inBlock = false;
    kept.push(line.trimEnd());
  }
  return createHash('sha256').update(`${kept.join('\n')}\n---\n${body.trim()}`).digest('hex').slice(0, 16);
}

/** The last `max` characters of a command's output, cut at a line. */
export function tailOf(text: string, max = 800): string {
  const trimmed = text.replace(/\r/g, '').trimEnd();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(-max);
  const newline = cut.indexOf('\n');
  return `…${newline >= 0 && newline < max / 2 ? cut.slice(newline) : cut}`;
}
