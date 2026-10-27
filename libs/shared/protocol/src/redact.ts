import { z } from 'zod';

/**
 * The redaction pass: known key shapes in text become `[redacted <kind> …a1b2]` (the kind, and the last four characters so two different keys can be
 * told apart). It is a pure function with fixtures (`redact.spec.ts`), so a false positive is a one-line change to a pattern. pi-kit runs it on what it writes to its own
 * database, on what it shows, and on everything that leaves through an export, a share or a bug report; pi's own session file is pi's and is not touched.
 *
 * Order matters: the specific shapes (`sk-or-`, `sk-ant-`) come before the general `sk-`, and the text that one pattern masked is not looked at by the next, because the mask
 * itself is not a key shape.
 */

export interface RedactionPattern {
  /** What the mask says: `openai key`, `github token`. */
  kind: string;
  pattern: RegExp;
  /** A text that every match contains: the pattern is only tried on text that has one of them (a plain `includes`, so most text costs nothing). User patterns have none. */
  hints?: readonly string[];
  /** Mask without the last four characters (a private key block has no useful tail). */
  noTail?: boolean;
}

/** The shapes pi-kit knows. Every pattern is global; `lastIndex` is reset per use. */
export const BUILTIN_PATTERNS: readonly RedactionPattern[] = [
  { kind: 'private key block', hints: ['PRIVATE KEY'], pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----|$)/g, noTail: true },
  { kind: 'openrouter key', hints: ['sk-or-'], pattern: /\bsk-or-(?:v\d+-)?[A-Za-z0-9_-]{24,}/g },
  { kind: 'anthropic key', hints: ['sk-ant-'], pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  { kind: 'openai key', hints: ['sk-'], pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'github token', hints: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'], pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { kind: 'aws access key', hints: ['AKIA', 'ASIA', 'AGPA', 'AIDA', 'AROA', 'ANPA', 'ANVA'], pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { kind: 'aws secret key', hints: ['aws_secret_access_key', 'AWS_SECRET_ACCESS_KEY'], pattern: /(?<=aws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi },
  { kind: 'slack token', hints: ['xox', 'xapp-'], pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g },
  { kind: 'google api key', hints: ['AIza'], pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe key', hints: ['_live_'], pattern: /\b[sr]k_live_[0-9A-Za-z]{20,}/g },
  { kind: 'bearer token', hints: ['Bearer'], pattern: /\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{20,}/g },
];

/** A pattern the user wrote in Settings › Advanced. */
export const UserRedactionPatternSchema = z.object({
  name: z.string().min(1).max(40),
  /** A JavaScript regular expression source (no slashes, no flags). */
  regex: z.string().min(1).max(300),
});
export type UserRedactionPattern = z.infer<typeof UserRedactionPatternSchema>;

/** What Settings › Advanced stores and the backend applies. */
export const RedactionConfigSchema = z.object({
  /** User-written patterns, applied after the built-in ones. */
  patterns: z.array(UserRedactionPatternSchema).max(30).default([]),
  /** Folders (workspace paths) where the pass is off: the person says their text looks like keys and is not. */
  offFor: z.array(z.string()).default([]),
});
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

/** `GET` and `PUT /api/redaction`: the configuration as stored, and the patterns that could not be used (not a valid expression, or one that matches the empty string). */
export const RedactionStateSchema = z.object({ config: RedactionConfigSchema, errors: z.array(z.string()) }).meta({ id: 'RedactionState' });
export type RedactionState = z.infer<typeof RedactionStateSchema>;

export const DEFAULT_REDACTION: RedactionConfig = { patterns: [], offFor: [] };

/** A user pattern compiled; the ones that are not valid expressions (or that match the empty string) are dropped, and named in `errors`. */
export function compileUserPatterns(patterns: readonly UserRedactionPattern[]): { compiled: RedactionPattern[]; errors: string[] } {
  const compiled: RedactionPattern[] = [];
  const errors: string[] = [];
  for (const { name, regex } of patterns) {
    try {
      const pattern = new RegExp(regex, 'g');
      if (pattern.test('')) throw new Error('it matches the empty text');
      compiled.push({ kind: name, pattern: new RegExp(regex, 'g') });
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { compiled, errors };
}

export interface RedactionResult {
  text: string;
  /** How many places were masked. */
  count: number;
  /** The kinds that were found, once each. */
  kinds: string[];
}

const tailOf = (match: string): string => (match.length >= 12 ? ` …${match.slice(-4)}` : '');
export const maskFor = (kind: string, match: string, noTail = false): string => `[redacted ${kind}${noTail ? '' : tailOf(match)}]`;

/** Masks every known key shape (and `extra` patterns) in a piece of text. Text without a match comes back as the same string. */
export function redactText(text: string, extra: readonly RedactionPattern[] = []): RedactionResult {
  if (text.length < 12) return { text, count: 0, kinds: [] };
  let out = text;
  let count = 0;
  const kinds = new Set<string>();
  for (const { kind, pattern, noTail, hints } of [...BUILTIN_PATTERNS, ...extra]) {
    if (hints && !hints.some((hint) => out.includes(hint))) continue;
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => {
      count += 1;
      kinds.add(kind);
      return maskFor(kind, match, noTail);
    });
  }
  return { text: out, count, kinds: [...kinds] };
}

/** `text` with its secrets masked, as a plain string (the common call). */
export const redact = (text: string, extra: readonly RedactionPattern[] = []): string => redactText(text, extra).text;

/**
 * A JSON value with every string in it passed through `redactText` (an object or array that held no secret comes back as the same object; one that did is copied). `skip` names keys whose values are left alone
 * (ids, types and timestamps never carry a secret and are looked at often).
 */
export function redactValue<T>(value: T, extra: readonly RedactionPattern[] = [], skip: ReadonlySet<string> = SKIPPED_KEYS): T {
  if (typeof value === 'string') return redactText(value, extra).text as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = redactValue(item, extra, skip);
      if (next !== item) changed = true;
      return next;
    });
    // The same array when nothing in it was masked: callers that compare by identity (a transcript that re-renders only what changed) keep their cache.
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = skip.has(key) ? item : redactValue(item, extra, skip);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/** Keys of AG-UI events and pi entries that hold ids, types and numbers, never text a person typed. */
export const SKIPPED_KEYS: ReadonlySet<string> = new Set(['type', 'id', 'messageId', 'toolCallId', 'runId', 'threadId', 'parentId', 'role', 'timestamp', 'name', 'toolName', 'model', 'provider']);

/** A JSON Lines file (pi's session format) with every line redacted; a line that is not JSON is redacted as text. */
export function redactJsonl(text: string, extra: readonly RedactionPattern[] = []): { text: string; count: number } {
  let count = 0;
  const lines = text.split('\n').map((line) => {
    if (line.trim() === '') return line;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const result = redactText(line, extra);
      count += result.count;
      return result.text;
    }
    const before = JSON.stringify(value);
    const next = redactValue(value, extra, new Set<string>());
    const after = JSON.stringify(next);
    if (before !== after) {
      count += 1;
      return after;
    }
    return line;
  });
  return { text: lines.join('\n'), count };
}
