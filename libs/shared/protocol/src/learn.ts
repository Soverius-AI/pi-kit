import { z } from 'zod';

/**
 * Skills learned from finished threads: the draft the attendant (or a request) writes, what the review dialog shows and sends back,
 * and the pure helpers for the text of a `SKILL.md` (name, description, the `x-pi-kit` provenance block). A draft lives in pi-kit's database; only an
 * approval writes a folder, and the only writer is the approve route.
 */

/** pi's rule for a skill name: lowercase letters, digits and single hyphens, at most 64 characters. */
export const SKILL_NAME_MAX = 64;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSkillName = (name: string): boolean => name.length > 0 && name.length <= SKILL_NAME_MAX && SKILL_NAME.test(name);

/** A name made from free text (a title the model gave): lowercase, hyphens, 64 characters; `undefined` when nothing is left. */
export function slugSkillName(text: string): string | undefined {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/g, '');
  return slug || undefined;
}

export const SkillScopeSchema = z.enum(['project', 'user']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillDraftStateSchema = z.enum(['pending', 'approved', 'discarded']);
export type SkillDraftState = z.infer<typeof SkillDraftStateSchema>;

/** Who asked for the draft: the attendant after an outcome, or the person (`/learn`, the badge menu, the thread menu). */
export const SkillDraftMakerSchema = z.enum(['attendant', 'person']);
export type SkillDraftMaker = z.infer<typeof SkillDraftMakerSchema>;

// ---- verification

/** The thresholds the verdict uses. A file or a hunk counts as reproduced when its changed lines are at least this similar (Dice over the lines added and removed). */
export const REPRODUCED_THRESHOLD = 0.8;
/** `pass` needs the whole diff at least this similar as well. */
export const PASS_SCORE = 0.9;
/** Below this similarity of the whole diff (or with no file reproduced) the replay `failed`. */
export const FAIL_SCORE = 0.3;

export const VerificationStateSchema = z.enum(['not-run', 'running', 'done', 'stopped', 'error']);
export type VerificationState = z.infer<typeof VerificationStateSchema>;
export const VerificationResultSchema = z.enum(['pass', 'partial', 'failed']);
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
/** Where a running verification is: making the scratch worktree, the thread running, comparing with the outcome, re-running the checks. */
export const VerificationPhaseSchema = z.enum(['worktree', 'run', 'compare', 'checks']);
export type VerificationPhase = z.infer<typeof VerificationPhaseSchema>;

/** One file of the comparison: what the outcome changed in it against what the replay changed. */
export const VerifiedFileSchema = z.object({
  path: z.string(),
  /** `same`: identical changes; `similar`: reproduced with differences; `different`: touched, not reproduced; `missing`: the replay did not touch it; `extra`: the replay touched a file the outcome did not. */
  status: z.enum(['same', 'similar', 'different', 'missing', 'extra']),
  /** 0 to 1. */
  similarity: z.number(),
  hunks: z.object({ matched: z.number().int().nonnegative(), expected: z.number().int().nonnegative(), actual: z.number().int().nonnegative() }),
});
export type VerifiedFile = z.infer<typeof VerifiedFileSchema>;

/** One check the original thread ran and what happened when it ran again in the scratch worktree. */
export const VerifiedCheckSchema = z.object({
  command: z.string(),
  originalPassed: z.boolean(),
  /** `skipped`: not run (a masked secret in the command, a path of the original folder, or the run was cut short); `note` says why. */
  state: z.enum(['passed', 'failed', 'skipped']),
  exitCode: z.number().int().nullable(),
  seconds: z.number().nonnegative(),
  /** The last lines of the output (at most 800 characters). */
  output: z.string(),
  note: z.string().optional(),
});
export type VerifiedCheck = z.infer<typeof VerifiedCheckSchema>;

/**
 * The record of "Verify" on a draft (stored in `skill_drafts.verification`, shown in the review dialog, summarised in the skill's `x-pi-kit.verified`). `requested` is the "Verify first" wish
 * of the approve dialog. While `state` is `running`, `phase` says where; `done` carries the result and the numbers; `stopped` is a run the person stopped; `error` is a verification that could not be
 * carried out (no scratch worktree, a project that is not trusted, a model that failed), which says nothing about the skill.
 */
export const SkillVerificationSchema = z.object({
  requested: z.boolean().optional(),
  state: VerificationStateSchema,
  phase: VerificationPhaseSchema.optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** The verification thread (archived afterwards; its scratch worktree is removed). */
  threadId: z.string().optional(),
  /** The first prompt the replay was given. */
  prompt: z.string().optional(),
  /** The model the replay ran with, `provider/id`. */
  model: z.string().optional(),
  /** The commit the replay started from, and the head of the outcome it is compared with. */
  base: z.string().optional(),
  head: z.string().optional(),
  /** A hash of the skill text that was verified (without the provenance block): an edit afterwards makes the report stale. */
  skillHash: z.string().optional(),
  result: VerificationResultSchema.optional(),
  /** Similarity of the whole diff, 0 to 1. */
  score: z.number().optional(),
  files: z.object({ reproduced: z.number().int().nonnegative(), expected: z.number().int().nonnegative(), extra: z.number().int().nonnegative() }).optional(),
  hunks: z.object({ matched: z.number().int().nonnegative(), expected: z.number().int().nonnegative(), actual: z.number().int().nonnegative() }).optional(),
  fileList: z.array(VerifiedFileSchema).optional(),
  checks: z.array(VerifiedCheckSchema).optional(),
  /** One sentence: "Reproduced 5 of 6 files and 14 of 18 hunks; 1 of 1 checks pass again." */
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
  tokens: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
}).meta({ id: 'SkillVerification' });
export type SkillVerification = z.infer<typeof SkillVerificationSchema>;

/** `GET /api/skill-drafts/:id/verify`: what a verification would do, for the dialog to show before it starts (the prompt is editable). */
export const VerifyPlanSchema = z.object({
  /** Whether a verification can start, and if not, why. */
  canVerify: z.boolean(),
  reason: z.string().optional(),
  /** The thread's first prompt, as it will be sent (the person may edit it). */
  prompt: z.string(),
  base: z.string().nullable(),
  head: z.string().nullable(),
  /** The files the outcome changed. */
  files: z.number().int().nonnegative(),
  /** The commands the thread ran as checks, which will be run again. */
  checks: z.array(z.object({ command: z.string(), originalPassed: z.boolean(), skip: z.string().optional() })),
  /** The model the replay will use, `provider/id` (the one the thread ran with), or null for pi's default. */
  model: z.string().nullable(),
  /** A verification is running now (this draft, or another). */
  busy: z.boolean(),
}).meta({ id: 'VerifyPlan' });
export type VerifyPlan = z.infer<typeof VerifyPlanSchema>;

/** `POST /api/skill-drafts/:id/verify`: the text the person has in the editor (it becomes the draft's text, and is what is replayed) and the prompt, both optional. */
export const StartVerifySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(200_000).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
}).strict().meta({ id: 'StartVerify' });
export type StartVerify = z.infer<typeof StartVerifySchema>;

/** The result of a draft's verification when it ran to the end: `done` with a result. */
export const verifiedResult = (verification: SkillVerification | null | undefined): VerificationResult | undefined =>
  verification?.state === 'done' ? verification.result : undefined;

/** The numbers a report states, as one sentence for the dialog, the card and the activity list. */
export function verificationSummary(v: SkillVerification): string {
  if (v.state === 'running') return 'Verifying…';
  if (v.state === 'stopped') return 'Stopped before it finished.';
  if (v.state === 'error') return v.error ?? 'Could not be verified.';
  if (v.state !== 'done' || !v.files || !v.hunks) return 'Not verified.';
  const checks = v.checks?.filter((c) => c.state !== 'skipped') ?? [];
  const checksText = checks.length === 0 ? '' : `; ${checks.filter((c) => c.state === 'passed').length} of ${checks.length} ${checks.length === 1 ? 'check passes' : 'checks pass'} again`;
  const extra = v.files.extra > 0 ? `, and touched ${v.files.extra} ${v.files.extra === 1 ? 'file' : 'files'} it should not have` : '';
  return `Reproduced ${v.files.reproduced} of ${v.files.expected} ${v.files.expected === 1 ? 'file' : 'files'} and ${v.hunks.matched} of ${v.hunks.expected} ${v.hunks.expected === 1 ? 'hunk' : 'hunks'}${extra}${checksText}.`;
}

/** A draft skill. `text` is the `SKILL.md` as pi will load it, frontmatter and provenance included. */
export const SkillDraftSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** The skill's name (also the folder's name). */
  name: z.string(),
  text: z.string(),
  /** Where Approve writes it unless the person chooses the other. */
  scope: SkillScopeSchema,
  state: SkillDraftStateSchema,
  /** The record of "Verify"; null until a verification was asked for. */
  verification: SkillVerificationSchema.nullable(),
  madeBy: SkillDraftMakerSchema,
  /** The model that wrote it, `provider/id`. */
  model: z.string().nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  /** The `SKILL.md` Approve wrote, once approved. */
  path: z.string().nullable(),
}).meta({ id: 'SkillDraft' });
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

/** The part of a draft the thread state carries: enough for the card, the sidebar chip and the thread menu. */
export const ThreadDraftBadgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: SkillDraftStateSchema,
  madeBy: SkillDraftMakerSchema,
  /** `running` while a verification replays the skill; else the result of the last one that ran to the end. */
  verification: z.enum(['running', 'pass', 'partial', 'failed']).nullable().optional(),
}).meta({ id: 'ThreadDraftBadge' });
export type ThreadDraftBadge = z.infer<typeof ThreadDraftBadgeSchema>;

/** `POST /api/threads/:id/skill-draft`: ask for a draft. `consent` answers the sentence of an earlier `consent` result (the attendant is off). */
export const RequestSkillDraftSchema = z.object({ consent: z.boolean().optional() }).strict().meta({ id: 'RequestSkillDraft' });
export type RequestSkillDraft = z.infer<typeof RequestSkillDraftSchema>;

/**
 * The answer of `POST /api/threads/:id/skill-draft`: the draft (new, or the thread's own when it has one that is pending), or `consent` when the transcript would go to a model
 * while the attendant is off and the person has not agreed for this thread yet (the sentence to show, and the model's name).
 */
export const SkillDraftRequestResultSchema = z.object({
  status: z.enum(['drafted', 'consent']),
  draft: SkillDraftSchema.optional(),
  /** `consent`: the model the transcript would go to. */
  model: z.string().optional(),
  /** `consent`: the sentence the person agrees to. */
  message: z.string().optional(),
}).meta({ id: 'SkillDraftRequestResult' });
export type SkillDraftRequestResult = z.infer<typeof SkillDraftRequestResultSchema>;

/** `POST /api/skill-drafts/:id/approve`: what the dialog sends back. The name, the scope and the text are the person's final ones. */
export const ApproveSkillDraftSchema = z.object({
  name: z.string().min(1).max(200),
  scope: SkillScopeSchema,
  text: z.string().min(1).max(200_000),
  /** "Verify first": records the wish when the draft has no verification yet. The dialog replays the skill before it sends Approve; the server does not insist. */
  verify: z.boolean().optional(),
}).strict().meta({ id: 'ApproveSkillDraft' });
export type ApproveSkillDraft = z.infer<typeof ApproveSkillDraftSchema>;

export const ApprovedSkillDraftSchema = z.object({ draft: SkillDraftSchema, path: z.string() }).meta({ id: 'ApprovedSkillDraft' });
export type ApprovedSkillDraft = z.infer<typeof ApprovedSkillDraftSchema>;

// ---- the text of a SKILL.md

/** The provenance puts in the frontmatter under `x-pi-kit`. */
export interface SkillProvenance {
  learnedFrom: string;
  base: string | null;
  head: string | null;
}

export interface ParsedSkillText {
  /** The text starts with a `---` block that is closed. */
  frontmatter: boolean;
  name: string | undefined;
  description: string | undefined;
  /** Everything after the frontmatter. */
  body: string;
  /** The raw lines of the frontmatter, without the fences. */
  lines: string[];
}

const unquote = (value: string): string => {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v) as string;
      } catch {
        return v.slice(1, -1);
      }
    }
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
};

/** Splits a `SKILL.md` into its frontmatter lines and body, and reads `name` and `description` (single-line scalars; anything else is left to pi's own parser at approval). */
export function parseSkillText(text: string): ParsedSkillText {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: false, name: undefined, description: undefined, body: normalized, lines: [] };
  const lines = match[1].split('\n');
  const top = (key: string): string | undefined => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    return line === undefined ? undefined : unquote(line.slice(key.length + 1));
  };
  return { frontmatter: true, name: top('name'), description: top('description'), body: normalized.slice(match[0].length), lines };
}

/** What is wrong with a skill text, as sentences for the dialog; none when pi can load it as far as pi-kit can tell (pi's parser has the last word at approval). */
export function skillTextProblems(text: string): string[] {
  const parsed = parseSkillText(text);
  const problems: string[] = [];
  if (!parsed.frontmatter) return ['The text has to start with a frontmatter block (--- name, description ---).'];
  if (!parsed.name) problems.push('The frontmatter has no name.');
  else if (!isSkillName(parsed.name)) problems.push('The name uses lowercase letters, digits and single hyphens, at most 64 characters.');
  if (!parsed.description) problems.push('The frontmatter has no description: pi does not load a skill without one.');
  else if (parsed.description.length > 1024) problems.push('The description is longer than 1024 characters.');
  if (!parsed.body.trim()) problems.push('The skill has no instructions after the frontmatter.');
  return problems;
}

/** The text with only its `name:` line replaced (added when there is none, or no frontmatter yet): what the review dialog's name field does to the text while the person types. */
export function setSkillName(text: string, name: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const parsed = parseSkillText(normalized);
  if (!parsed.frontmatter) return `---\nname: ${name}\n---\n${normalized}`;
  const at = parsed.lines.findIndex((l) => l.startsWith('name:'));
  const lines = [...parsed.lines];
  if (at >= 0) lines[at] = `name: ${name}`;
  else lines.unshift(`name: ${name}`);
  return `---\n${lines.join('\n')}\n---\n${parsed.body}`;
}

/** A plain YAML scalar that would be read wrongly (a colon and a space, ` #`, a leading indicator) in double quotes; anything already quoted or safe as it is. */
function yamlScalar(value: string): string {
  const v = value.trim();
  if (v === '' || /^["']/.test(v)) return v;
  return /: |:$| #|^[-?:,[\]{}#&*!|>%@`]/.test(v) ? JSON.stringify(v) : v;
}

/** The skill text with `name` and `description` safe to read as YAML (a description with a colon is quoted) and `name` set to `name` when given. */
export function normalizeSkillText(text: string, name?: string): string {
  const parsed = parseSkillText(text);
  if (!parsed.frontmatter) return text;
  const lines = parsed.lines.map((line) => {
    const m = /^(name|description):(.*)$/.exec(line);
    if (!m) return line;
    if (m[1] === 'name' && name !== undefined) return `name: ${name}`;
    return `${m[1]}: ${yamlScalar(m[2])}`;
  });
  if (name !== undefined && !lines.some((l) => l.startsWith('name:'))) lines.unshift(`name: ${name}`);
  return `---\n${lines.join('\n')}\n---\n${parsed.body}`.replace(/\n*$/, '\n');
}

/**
 * The `verified` entry of the `x-pi-kit` block for a verification that ran to the end, as the lines the block holds; ` verified: null` for anything else
 * (not run, running, stopped, failed to start): the frontmatter only ever states a result that was measured.
 */
export function verifiedLines(verification: SkillVerification | null | undefined): string[] {
  const v = verification;
  if (!v || v.state !== 'done' || !v.result || !v.files || !v.hunks) return ['  verified: null'];
  const checks = v.checks?.filter((c) => c.state !== 'skipped') ?? [];
  return [
    '  verified:',
    `    result: ${v.result}`,
    `    at: ${new Date(v.finishedAt ?? Date.now()).toISOString()}`,
    `    files: ${v.files.reproduced}/${v.files.expected}`,
    `    hunks: ${v.hunks.matched}/${v.hunks.expected}`,
    ...(checks.length > 0 ? [`    checks: ${checks.filter((c) => c.state === 'passed').length}/${checks.length}`] : []),
    ...(v.score !== undefined ? [`    similarity: ${v.score.toFixed(2)}`] : []),
    ...(v.base ? [`    replayedFrom: ${v.base}`] : []),
  ];
}

/** The text with the `verified` entry of its `x-pi-kit` block replaced by `verification`'s (see `verifiedLines`). A text without an `x-pi-kit` block is returned as it is. */
export function stampVerified(text: string, verification: SkillVerification | null | undefined): string {
  const parsed = parseSkillText(text);
  if (!parsed.frontmatter) return text;
  const at = parsed.lines.findIndex((l) => l.startsWith('x-pi-kit:'));
  if (at < 0) return text;
  let end = at + 1;
  while (end < parsed.lines.length && /^\s+\S/.test(parsed.lines[end])) end += 1;
  const block = parsed.lines.slice(at + 1, end);
  const verified = block.findIndex((l) => /^\s{2}verified:/.test(l));
  const kept = verified >= 0 ? block.slice(0, verified) : block;
  const lines = [...parsed.lines.slice(0, at + 1), ...kept, ...verifiedLines(verification), ...parsed.lines.slice(end)];
  return `---\n${lines.join('\n')}\n---\n${parsed.body}`.replace(/\n*$/, '\n');
}

/** The `x-pi-kit.verified` result a text states, if it states one: `pass`, `partial` or `failed`. */
export function verifiedResultOfText(text: string): VerificationResult | undefined {
  const { lines } = parseSkillText(text);
  const at = lines.findIndex((l) => /^\s{2}verified:\s*$/.test(l));
  if (at < 0) return undefined;
  for (let i = at + 1; i < lines.length && /^\s{4}\S/.test(lines[i]); i++) {
    const m = /^\s{4}result:\s*(\S+)/.exec(lines[i]);
    if (m && VerificationResultSchema.safeParse(m[1]).success) return m[1] as VerificationResult;
  }
  return undefined;
}

/**
 * The text with the `x-pi-kit` block set: where the skill was learned from, the commits that bracket the thread's outcome, and the verification record.
 * Lines of an existing block that this does not own (`verified`, written by verification) are kept; the rest is replaced.
 */
export function stampProvenance(text: string, provenance: SkillProvenance): string {
  const parsed = parseSkillText(text);
  if (!parsed.frontmatter) return text;
  const kept: string[] = [];
  const own: string[] = [];
  let inBlock = false;
  for (const line of parsed.lines) {
    if (line.startsWith('x-pi-kit:')) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\s+\S/.test(line)) {
      own.push(line);
      continue;
    }
    inBlock = false;
    kept.push(line);
  }
  // `verified` can have nested lines (a report); everything from its line to the end of the block stays.
  const start = own.findIndex((l) => /^\s{2}verified:/.test(l));
  const verified = start >= 0 ? own.slice(start) : ['  verified: null'];
  const sha = (value: string | null): string => (value ? value : 'null');
  const block = ['x-pi-kit:', `  learnedFrom: ${provenance.learnedFrom}`, `  base: ${sha(provenance.base)}`, `  head: ${sha(provenance.head)}`, ...verified];
  return `---\n${[...kept, ...block].join('\n')}\n---\n${parsed.body}`.replace(/\n*$/, '\n');
}

/** The `learnedFrom` thread of a skill text's provenance block, if it has one. */
export function provenanceOf(text: string): { learnedFrom: string | undefined; base: string | undefined; head: string | undefined } {
  const { lines } = parseSkillText(text);
  const at = lines.findIndex((l) => l.startsWith('x-pi-kit:'));
  const read = (key: string): string | undefined => {
    if (at < 0) return undefined;
    for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
      const m = new RegExp(`^\\s{2}${key}:\\s*(.*)$`).exec(lines[i]);
      if (m) return m[1].trim() === 'null' ? undefined : unquote(m[1]);
    }
    return undefined;
  };
  return { learnedFrom: read('learnedFrom'), base: read('base'), head: read('head') };
}

// ---- the record of a learned skill

/** The kinds of outcome a use is marked with (`OutcomeKind` of the outcome store, restated here so this file stays free of the outcome module). */
export const UseOutcomeSchema = z.enum(['merged', 'committed', 'pr']);
export type UseOutcome = z.infer<typeof UseOutcomeSchema>;

/** The last verification of a learned skill, as the Settings row says it: from the draft's record, or from the `x-pi-kit.verified` block of the file when the draft has none. */
export const LearnedVerificationSchema = z.object({
  /** `done` with a result, or why there is none (`stopped`, `error`, `running`). */
  state: z.enum(['running', 'done', 'stopped', 'error']),
  result: VerificationResultSchema.optional(),
  /** While `running`: where the replay is. */
  phase: VerificationPhaseSchema.optional(),
  /** When it finished (ms since the epoch). */
  at: z.number().optional(),
  summary: z.string().optional(),
  /** The skill was edited after this report, so the report is for another text. */
  stale: z.boolean(),
}).meta({ id: 'LearnedVerification' });
export type LearnedVerification = z.infer<typeof LearnedVerificationSchema>;

/** Why a learned skill is flagged in Settings. */
export const LearnedFlagSchema = z.object({
  reason: z.enum(['no-outcomes', 'failed-verification']),
  /** The sentence the row shows. */
  text: z.string(),
}).meta({ id: 'LearnedFlag' });
export type LearnedFlag = z.infer<typeof LearnedFlagSchema>;

/** One learned skill and its record. `id` is the draft's id: the draft is where the skill was approved, and its row keeps the retirement. */
export const LearnedSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: SkillScopeSchema,
  /** The `SKILL.md` Approve wrote (where the skill lives when it is not retired). */
  path: z.string(),
  /** The folder is in `.retired/`, not loaded by pi; null when the skill is live. */
  retiredAt: z.number().nullable(),
  /** The `SKILL.md` is not where it should be any more (moved or deleted by hand). */
  missing: z.boolean(),
  /** Where it was learned from. `title` is null once the thread is gone. */
  learnedFrom: z.object({ threadId: z.string(), title: z.string().nullable(), base: z.string().nullable(), head: z.string().nullable() }),
  verification: LearnedVerificationSchema.nullable(),
  /** The prompts that used the skill (a chip or `/skill:name`), in any thread. */
  uses: z.number().int(),
  /** The uses whose thread landed a merged outcome. */
  mergedAfterUse: z.number().int(),
  /** The threads that used it. */
  threads: z.number().int(),
  lastUsedAt: z.number().nullable(),
  flag: LearnedFlagSchema.nullable(),
}).meta({ id: 'LearnedSkill' });
export type LearnedSkill = z.infer<typeof LearnedSkillSchema>;

/** One learned skill with its file as it is on disk now, and the draft it was approved from (its verification record, who made it): what the edit dialog works on. */
export const LearnedSkillDetailSchema = LearnedSkillSchema.extend({ text: z.string(), draft: SkillDraftSchema }).meta({ id: 'LearnedSkillDetail' });
export type LearnedSkillDetail = z.infer<typeof LearnedSkillDetailSchema>;

/** `POST /api/skills/learned/:id/save`: the edited text of an approved skill. The name stays; the provenance is stamped again by the server. */
export const SaveLearnedSkillSchema = z.object({ text: z.string().min(1).max(200_000) }).strict().meta({ id: 'SaveLearnedSkill' });
export type SaveLearnedSkill = z.infer<typeof SaveLearnedSkillSchema>;

/** A thread that used a skill, for the flag rule: when it last did, the outcome it ended with, and whether it has ended (it is not running). */
export interface UsingThread {
  threadId: string;
  lastUseAt: number;
  outcome: UseOutcome | null;
  ended: boolean;
}

/** How many of the latest threads the flag looks at. */
export const FLAG_THREADS = 3;

/**
 * The flag: "a learned skill whose threads keep failing". It looks at the last three threads that used the skill and have ended (a thread that still runs has not
 * failed yet). Fewer than three: no flag. Flagged when all three ended **without an outcome** (nothing was merged, committed or opened as a pull request), or when the skill's last
 * verification **failed** and none of the three merged. A skill whose threads merged is never flagged by a failed replay alone.
 */
export function learnedFlag(threads: readonly UsingThread[], verification: VerificationResult | undefined): LearnedFlag | null {
  const last = threads
    .filter((t) => t.ended || t.outcome !== null)
    .sort((a, b) => b.lastUseAt - a.lastUseAt)
    .slice(0, FLAG_THREADS);
  if (last.length < FLAG_THREADS) return null;
  if (last.every((t) => t.outcome === null)) return { reason: 'no-outcomes', text: 'Its last three threads ended without a commit, merge or pull request.' };
  if (verification === 'failed' && !last.some((t) => t.outcome === 'merged')) return { reason: 'failed-verification', text: 'It did not reproduce its thread when it was last verified, and none of its last three threads merged.' };
  return null;
}

/** The result and time of the `x-pi-kit.verified` block of a skill file, if it states one. */
export function verifiedOfText(text: string): { result: VerificationResult; at: number | undefined } | undefined {
  const result = verifiedResultOfText(text);
  if (!result) return undefined;
  const { lines } = parseSkillText(text);
  const line = lines.find((l) => /^\s{4}at:\s*\S/.test(l));
  const at = line ? Date.parse(line.replace(/^\s{4}at:\s*/, '').trim()) : Number.NaN;
  return { result, at: Number.isNaN(at) ? undefined : at };
}
