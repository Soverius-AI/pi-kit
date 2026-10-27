import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { REVIEW_ENTRY_TYPE, ReviewBatchSchema, SKILLS_ENTRY_TYPE, SkillsEntrySchema, type RedactionPattern, type ThreadTranscript, type TranscriptAnswer, type TranscriptTurn, redactText } from '@pi-kit/protocol';
import { branchOf } from '../attendant/attendant-text';
import { normalizeToolPath } from '../changes/touched';

/**
 * The thread reduced for the analysis: what the person asked, the tool calls (name, target, outcome), the errors and how they were recovered,
 * the checks that were run, and the outcome's diff and commit message, all passed through the redaction pass before they leave this function. Pure: the session
 * entries and the git facts go in, a `ThreadTranscript` comes out, so it is tested without pi or a repository.
 */

const PROMPT_CHARS = 1500;
const MAX_PROMPTS = 12;
const TARGET_CHARS = 200;
const MESSAGE_CHARS = 240;
const DIFF_CHARS = 14_000;
const COMMIT_CHARS = 1500;
/** A message that arrives this soon after the entry before it was queued: pi took it up the moment the turn before ended (a follow-up or a steer), nobody was waiting on it. */
export const QUEUED_WITHIN_MS = 2000;
const PREVIOUS_CHARS = 400;
const TURN_FILES = 40;
const TURN_COMMENTS = 40;
const COMMENT_CHARS = 500;
const MAX_TURNS = 60;
/** More steps than this and the middle of the list is left out (the errors and the checks are always kept). */
export const MAX_STEPS = 200;
const HEAD_STEPS = 60;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  text?: string;
}

interface Message {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  exitCode?: number;
  cancelled?: boolean;
}

const squeeze = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
};

/** What a tool call was about: the file, the command, the pattern or the address, whichever its arguments name first. */
export function targetOf(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ['path', 'file_path', 'filePath', 'file', 'command', 'pattern', 'url', 'query', 'name']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return squeeze(value, TARGET_CHARS);
  }
  return null;
}

const CHECKS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck|verify|e2e)\b/,
  /\bnpx\s+(?:nx|vitest|jest|eslint|tsc|playwright|prettier)\b/,
  /\b(?:vitest|jest|mocha|pytest|tox|rspec|phpunit|ctest|ava)\b/,
  /\b(?:tsc|eslint|ruff|mypy|flake8|golangci-lint)\b/,
  /\bprettier\b.*--check/,
  /\bcargo\s+(?:test|check|build|clippy)\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\bmake\s+(?:test|check|build|lint)\b/,
  /\b(?:dotnet|gradle|mvn|\.\/gradlew)\s+(?:test|build|check|verify)\b/,
  /\bnode\s+--test\b/,
];

/** A shell command that checks the work: a test run, a build, a type check, a linter. */
export const isCheckCommand = (command: string): boolean => CHECKS.some((pattern) => pattern.test(command));

export interface OutcomeFacts {
  base: string | null;
  head: string | null;
  /** `git diff base..head`. */
  diff: string | null;
  changedLines: number;
  commitMessage: string | null;
}

export interface ReduceInput {
  threadId: string;
  title: string | null;
  cwd: string;
  entries: readonly PiSessionEntry[];
  leafId: string | null;
  outcome?: OutcomeFacts | undefined;
  /** The user's own patterns of the redaction pass, on top of the built-in ones. */
  patterns?: readonly RedactionPattern[];
  /** The dialogs the person answered in this thread; each lands on the message pi was working on at its time. */
  answers?: readonly (TranscriptAnswer & { at: number })[];
  /** The folder the session's tool paths are relative to, to name the files pi edited per message. */
  folder?: string;
}

interface Step {
  n: number;
  tool: string;
  target: string | null;
  outcome: 'ok' | 'error' | 'unknown';
  message?: string;
}

/** A turn while it is being built: one user message and what came of it, until the next user message. */
interface TurnBuild {
  n: number;
  at: number | null;
  text: string;
  queued: boolean;
  gapMs: number | null;
  toolCalls: number;
  files: Set<string>;
  chips: { kind: 'skill' | 'prompt'; name: string }[];
  review: TranscriptTurn['review'];
  previous: string | null;
}

const timeOf = (entry: PiSessionEntry): number | null => {
  const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const tail = (text: string, max: number): string => (text.length > max ? `…${text.slice(text.length - max + 1)}` : text);

export function reduceTranscript(input: ReduceInput): ThreadTranscript {
  const prompts: string[] = [];
  const steps: Step[] = [];
  const byCall = new Map<string, Step>();
  let toolCalls = 0;
  const turns: TurnBuild[] = [];
  let current: TurnBuild | undefined;
  let messages = 0;
  /** A `pi-kit.review` / `pi-kit.skills` custom entry is written right before the prompt it belongs to. */
  let pendingReview: TranscriptTurn['review'] = null;
  let pendingChips: { chips: { kind: 'skill' | 'prompt'; name: string }[]; text: string } | undefined;
  let lastAssistant = '';
  let lastAt: number | null = null;
  for (const entry of branchOf(input.entries, input.leafId)) {
    if (entry.type === 'custom' && entry['customType'] === REVIEW_ENTRY_TYPE) {
      const batch = ReviewBatchSchema.safeParse(entry['data']);
      if (batch.success) pendingReview = batch.data.comments.slice(0, TURN_COMMENTS).map((c) => ({ file: c.file, side: c.side, line: c.line, ...(c.endLine !== undefined ? { endLine: c.endLine } : {}), text: squeeze(c.text, COMMENT_CHARS), snippet: squeeze(c.snippet, COMMENT_CHARS) }));
      continue;
    }
    if (entry.type === 'custom' && entry['customType'] === SKILLS_ENTRY_TYPE) {
      const chips = SkillsEntrySchema.safeParse(entry['data']);
      if (chips.success) pendingChips = { chips: chips.data.chips.map((c) => ({ kind: c.kind, name: c.name })), text: chips.data.text };
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry['message'] as Message | undefined;
    if (!message) continue;
    const at = timeOf(entry);
    if (message.role === 'user') {
      const text = squeeze(textOf(message.content), PROMPT_CHARS);
      if (text && prompts.length < MAX_PROMPTS) prompts.push(text);
      if (text) {
        messages += 1;
        const gap = lastAt !== null && at !== null ? Math.max(0, at - lastAt) : null;
        current = {
          n: messages,
          at,
          // A message with chips is shown as it was typed; the message itself holds the expanded instructions.
          text: squeeze(pendingChips?.text || text, PROMPT_CHARS),
          queued: messages > 1 && gap !== null && gap < QUEUED_WITHIN_MS,
          gapMs: messages > 1 ? gap : null,
          toolCalls: 0,
          files: new Set<string>(),
          chips: pendingChips?.chips ?? [],
          review: pendingReview,
          previous: lastAssistant ? tail(lastAssistant, PREVIOUS_CHARS) : null,
        };
        if (turns.length < MAX_TURNS) turns.push(current);
        pendingReview = null;
        pendingChips = undefined;
        lastAssistant = '';
      }
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      const said = textOf(message.content).trim();
      if (said) lastAssistant = squeeze(said, 2000);
      for (const block of message.content as Block[]) {
        if (block.type !== 'toolCall' || !block.name) continue;
        const step: Step = { n: steps.length + 1, tool: block.name, target: targetOf(block.arguments), outcome: 'unknown' };
        steps.push(step);
        toolCalls += 1;
        if (current) {
          current.toolCalls += 1;
          if ((block.name === 'edit' || block.name === 'write') && current.files.size < TURN_FILES && input.folder) {
            const path = normalizeToolPath(input.folder, block.arguments?.['path']);
            if (path) current.files.add(path);
          }
        }
        if (block.id) byCall.set(block.id, step);
      }
    } else if (message.role === 'toolResult' && message.toolCallId) {
      const step = byCall.get(message.toolCallId);
      if (step) {
        step.outcome = message.isError ? 'error' : 'ok';
        if (message.isError) step.message = squeeze(textOf(message.content) || 'The tool failed.', MESSAGE_CHARS);
      }
    } else if (message.role === 'bashExecution' && typeof message.command === 'string') {
      // A `!command` the person ran themselves: it is a step like any other, and a check when it is one.
      steps.push({ n: steps.length + 1, tool: 'bash', target: squeeze(message.command, TARGET_CHARS), outcome: message.cancelled ? 'unknown' : message.exitCode === 0 ? 'ok' : 'error', ...(message.exitCode ? { message: `exit code ${message.exitCode}` } : {}) });
    }
    if (at !== null) lastAt = at;
  }

  // The dialogs the person answered land on the message pi was working on at the time.
  const answersByTurn = new Map<number, TranscriptAnswer[]>();
  for (const answer of input.answers ?? []) {
    const owner = [...turns].reverse().find((t) => t.at !== null && t.at <= answer.at);
    if (!owner) continue;
    const { at: _at, ...rest } = answer;
    answersByTurn.set(owner.n, [...(answersByTurn.get(owner.n) ?? []), rest]);
  }
  const builtTurns: TranscriptTurn[] = turns.map((t) => ({
    n: t.n,
    at: t.at,
    text: t.text,
    queued: t.queued,
    gapMs: t.gapMs,
    toolCalls: t.toolCalls,
    files: [...t.files],
    chips: t.chips,
    review: t.review,
    answers: answersByTurn.get(t.n) ?? [],
    previous: t.previous,
  }));

  const errors = steps
    .filter((s) => s.outcome === 'error')
    .map((s) => {
      const later = steps.find((l) => l.n > s.n && l.outcome === 'ok' && l.tool === s.tool && l.target === s.target);
      return { step: s.n, tool: s.tool, target: s.target, message: s.message ?? 'The tool failed.', recovered: later !== undefined, recoveredBy: later?.n ?? null };
    });
  const checks = steps.filter((s) => s.tool === 'bash' && s.target !== null && s.outcome !== 'unknown' && isCheckCommand(s.target)).map((s) => ({ step: s.n, command: s.target as string, passed: s.outcome === 'ok' }));

  let truncated = false;
  let listed: Step[] = steps;
  if (steps.length > MAX_STEPS) {
    truncated = true;
    const keep = new Set<number>([...steps.slice(0, HEAD_STEPS).map((s) => s.n), ...steps.slice(-(MAX_STEPS - HEAD_STEPS)).map((s) => s.n), ...errors.map((e) => e.step), ...checks.map((c) => c.step)]);
    listed = steps.filter((s) => keep.has(s.n));
  }

  let diff = input.outcome?.diff ?? null;
  if (diff !== null && diff.length > DIFF_CHARS) {
    diff = `${diff.slice(0, DIFF_CHARS)}\n… (the diff is longer; the rest is left out)`;
    truncated = true;
  }
  const commit = input.outcome?.commitMessage ?? null;

  const raw: ThreadTranscript = {
    threadId: input.threadId,
    title: input.title,
    cwd: input.cwd,
    prompts,
    toolCalls,
    turns: builtTurns,
    steps: listed.map(({ n, tool, target, outcome }) => ({ n, tool, target, outcome })),
    errors,
    checks,
    diff,
    changedLines: input.outcome?.changedLines ?? 0,
    commitMessage: commit === null ? null : commit.length > COMMIT_CHARS ? `${commit.slice(0, COMMIT_CHARS)}…` : commit,
    base: input.outcome?.base ?? null,
    head: input.outcome?.head ?? null,
    truncated,
    redactions: 0,
  };
  return redactTranscript(raw, input.patterns ?? []);
}

/** Every string of the transcript through the redaction pass; the count of masked places is recorded in the result. */
export function redactTranscript(transcript: ThreadTranscript, patterns: readonly RedactionPattern[] = []): ThreadTranscript {
  let count = 0;
  const pass = (text: string): string => {
    const result = redactText(text, patterns);
    count += result.count;
    return result.text;
  };
  const maybe = (text: string | null): string | null => (text === null ? null : pass(text));
  /** A turn's text is the same message as the prompt of the same number: masked, but not counted twice. */
  const quiet = (text: string): string => redactText(text, patterns).text;
  return {
    ...transcript,
    title: maybe(transcript.title),
    prompts: transcript.prompts.map(pass),
    turns: transcript.turns?.map((t) => ({
      ...t,
      text: quiet(t.text),
      files: t.files.map(pass),
      previous: maybe(t.previous),
      review: t.review ? t.review.map((c) => ({ ...c, file: pass(c.file), text: pass(c.text), snippet: pass(c.snippet) })) : null,
      answers: t.answers.map((a) => ({ ...a, title: pass(a.title), ...(a.value !== undefined ? { value: pass(a.value) } : {}) })),
    })),
    steps: transcript.steps.map((s) => ({ ...s, target: maybe(s.target) })),
    errors: transcript.errors.map((e) => ({ ...e, target: maybe(e.target), message: pass(e.message) })),
    checks: transcript.checks.map((c) => ({ ...c, command: pass(c.command) })),
    diff: maybe(transcript.diff),
    commitMessage: maybe(transcript.commitMessage),
    redactions: count,
  };
}
