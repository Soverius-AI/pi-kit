// The ledger of @pi-kit/meat-proxy: what the person put into a thread, counted without a model. Plain ESM, no dependencies.
//
// It reads what pi-kit's plugin events hand over: the reduced transcript with its `turns` (one per user message: when it was sent, whether pi picked it up from the queue, the tool
// calls and edited files that followed, the skill chips, the review comments, the dialog answers), the baselines (the files the thread's runs changed), and the hunks of the
// outcome diff. A file of the outcome that no run of the thread changed was changed outside pi. It never touches a database or a file: everything goes in as plain data, so it is tested against recorded fixtures.

const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|css|scss|html|yml|yaml|toml|sql|sh|c|h|cpp|cs|swift|kt|vue|svelte|txt|xml|php|lock';
const PATH_LIKE = new RegExp(
  `(?:[\\w@.-]+/)*[\\w@-]+\\.(?:${FILE_EXT})\\b|\\b(?:src|lib|app|apps|libs|packages|test|tests|spec|docs|scripts)/[\\w@./-]+`,
  'g',
);
const LINE_REFS = [
  /\blines?\s+\d+(?:\s*(?:-|–|to|and)\s*\d+)?/gi,
  /\b(?:L|#L)\d+(?:-L?\d+)?\b/g,
  /(?<=[\w)\]]):\d{1,5}(?::\d{1,4})?\b/g,
];
const COMMAND_START =
  /^(?:\$\s*)?(?:npm|npx|pnpm|yarn|bun|node|deno|git|python3?|pip|pytest|cargo|go|make|docker|curl|ls|cat|grep|sed|tsc|eslint|vitest|jest|nx)\b/;
const INLINE_CODE = /`([^`\n]{1,200})`/g;
const FENCE = /```[\s\S]*?```/g;
const CODE_SHAPE = /[A-Za-z_]\w*\([^)]*\)|=>|::|\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b|[{};]/;

const unique = (list) => [...new Set(list)];

/** How concrete a message is: the files, lines, commands and code it names. `level`: `vague` (nothing), `pointed` (one or two kinds), `precise` (three or four). */
export function specificityOf(text, knownFiles = []) {
  const source = String(text ?? '');
  const fenced = [...source.matchAll(FENCE)].map((m) => m[0]);
  const prose = source.replace(FENCE, ' ');
  const spans = [...prose.matchAll(INLINE_CODE)].map((m) => m[1].trim());

  const files = [];
  for (const m of prose.matchAll(PATH_LIKE)) {
    const token = m[0].replace(/^\.\//, '');
    // A version number or a domain is not a file: it needs a known extension, or a slash with a letter in it.
    if (/^\d+(?:\.\d+)+$/.test(token) || /^(?:https?:)?\/\//.test(token)) continue;
    files.push(token);
  }
  const lower = prose.toLowerCase();
  for (const path of knownFiles) {
    const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (
      lower.includes(path.toLowerCase()) ||
      (base.includes('.') &&
        new RegExp(`(?<![\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(lower))
    )
      files.push(path);
  }

  const lines = [];
  for (const pattern of LINE_REFS) for (const m of prose.matchAll(pattern)) lines.push(m[0].trim());

  const commands = [];
  const code = fenced.length > 0 ? fenced.slice() : [];
  for (const span of spans) {
    if (COMMAND_START.test(span)) commands.push(span);
    else if (CODE_SHAPE.test(span)) code.push(span);
  }
  for (const line of prose.split('\n')) if (/^\s*\$\s+\S/.test(line)) commands.push(line.trim().replace(/^\$\s*/, ''));
  for (const fence of fenced) {
    for (const line of fence.split('\n').slice(1, -1))
      if (/^\s*\$\s+\S/.test(line)) commands.push(line.trim().replace(/^\$\s*/, ''));
  }

  const kinds = [files.length > 0, lines.length > 0, commands.length > 0, code.length > 0].filter(Boolean).length;
  return {
    files: unique(files),
    lines: unique(lines),
    commands: unique(commands),
    code: code.length > 0,
    kinds,
    level: kinds === 0 ? 'vague' : kinds >= 3 ? 'precise' : 'pointed',
  };
}

const NEGATION =
  /^\s*(?:no|nope|nah|wrong|stop|wait|hold on|hmm,? no|not (?:that|this|quite|like that))\b(?=[\s,.!:;-]|$)/i;
const REVERSE = /\b(?:undo|revert|roll\s*back|put (?:it|that|them) back|go back to|restore the)\b/i;
const INSTEAD =
  /\b(?:instead|rather than|that'?s not|that is not|that (?:was|is) wrong|doesn'?t work|didn'?t work|not what i|you (?:broke|missed|forgot|removed|deleted|changed|ignored)|why did you|shouldn'?t have|should not have|i said)\b/i;
const QUOTES = [/"([^"\n]{8,200})"/g, /“([^”\n]{8,200})”/g, /`([^`\n]{8,200})`/g, /^>\s*(.{8,200})$/gm];

/**
 * Whether a message corrects what pi did before it, by a small rule set: it starts with a "no"/"not that", reverses ("undo", "revert", "go back to"), says "instead" or "that's
 * not", or quotes pi's own words back (`previous` is what pi last said). Review comments count as corrections. The first message of a thread corrects nothing.
 */
export function correctionOf(text, { previous = null, reviewComments = 0, first = false } = {}) {
  const signals = [];
  const source = String(text ?? '');
  if (!first) {
    if (NEGATION.test(source)) signals.push('negation');
    if (REVERSE.test(source)) signals.push('undo');
    if (INSTEAD.test(source)) signals.push('instead');
    const said = String(previous ?? '').toLowerCase();
    if (said) {
      const quoted = QUOTES.some((pattern) =>
        [...source.matchAll(pattern)].some((m) => said.includes(m[1].trim().toLowerCase())),
      );
      if (quoted) signals.push('quotes-pi');
    }
  }
  if (reviewComments > 0) signals.push('review');
  return { is: signals.length > 0, signals };
}

/** Turns for a transcript from an older pi-kit that has prompts only. */
function fallbackTurns(prompts) {
  return (prompts ?? []).map((text, i) => ({
    n: i + 1,
    at: null,
    text,
    queued: false,
    gapMs: null,
    toolCalls: 0,
    files: [],
    chips: [],
    review: null,
    answers: [],
    previous: null,
  }));
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * The ledger of a finished thread. `transcript` is the payload of `pi-kit:thread:transcript`, `baselines` the `files` of `pi-kit:thread:baselines`, `hunks` the output of
 * `splitDiff`.
 */
export function buildLedger({ transcript, baselines = [], hunks = [] }) {
  const piTouched = new Map(baselines.map((b) => [b.path, b]));
  const inDiff = unique(hunks.map((h) => h.file));
  const known = unique([...inDiff, ...piTouched.keys()]);
  const turns = transcript.turns && transcript.turns.length > 0 ? transcript.turns : fallbackTurns(transcript.prompts);

  const messages = turns.map((t) => {
    const review = t.review ?? [];
    return {
      n: t.n,
      kind: t.n === 1 ? 'first' : t.queued ? 'queued' : 'follow-up',
      at: t.at ?? null,
      gapMs: t.gapMs ?? null,
      length: t.text.length,
      specificity: specificityOf(t.text, known),
      correction: correctionOf(t.text, { previous: t.previous, reviewComments: review.length, first: t.n === 1 }),
      toolCalls: t.toolCalls ?? 0,
      files: t.files ?? [],
      chips: t.chips ?? [],
      review,
      answers: t.answers ?? [],
      text: t.text,
    };
  });

  const files = known.map((path) => {
    const named = messages.filter((m) => m.specificity.files.includes(path)).map((m) => m.n);
    const reviewed = messages.flatMap((m) =>
      m.review.filter((c) => c.file === path).map((c) => ({ n: m.n, line: c.line, endLine: c.endLine ?? null })),
    );
    return {
      path,
      inDiff: inDiff.includes(path),
      named,
      reviewed,
      piTouched: piTouched.has(path)
        ? { turn: piTouched.get(path).turn ?? null, edits: piTouched.get(path).edits ?? null }
        : null,
    };
  });

  const gaps = messages.filter((m) => m.kind !== 'queued' && m.gapMs !== null).map((m) => m.gapMs);
  const toolCalls = transcript.toolCalls ?? messages.reduce((n, m) => n + m.toolCalls, 0);
  return {
    messages,
    files,
    /** Files in the outcome that no run of the thread changed: they were changed outside pi, so every hunk of them is the person's. */
    handOnly: files.filter((f) => f.inDiff && !f.piTouched).map((f) => f.path),
    totals: {
      messages: messages.length,
      corrections: messages.filter((m) => m.correction.is).length,
      reviewBatches: messages.filter((m) => m.review.length > 0).length,
      reviewComments: messages.reduce((n, m) => n + m.review.length, 0),
      dialogAnswers: messages.reduce((n, m) => n + m.answers.length, 0),
      chips: messages.reduce((n, m) => n + m.chips.length, 0),
      unattendedTurns: messages.filter((m) => m.kind === 'queued').length,
      toolCalls,
      toolCallsPerMessage: messages.length ? Math.round((toolCalls / messages.length) * 10) / 10 : 0,
      handEditedInOutcome: files.filter((f) => f.inDiff && !f.piTouched).length,
      waitMs: gaps.reduce((a, b) => a + b, 0),
      medianGapMs: median(gaps),
    },
  };
}

const clip = (text, max) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const seconds = (ms) =>
  ms === null || ms === undefined
    ? null
    : ms < 90_000
      ? `${Math.round(ms / 1000)} s`
      : `${Math.round(ms / 60_000)} min`;

/** The ledger as the text the model reads (and the person can read: `/score` prints it): one block per message, then the files. */
export function ledgerToText(ledger, { messageChars = 600 } = {}) {
  const out = [];
  out.push('## What the person did, message by message');
  for (const m of ledger.messages) {
    const bits = [];
    bits.push(
      m.kind === 'first'
        ? 'first prompt'
        : m.kind === 'queued'
          ? 'queued message (pi picked it up unattended)'
          : 'follow-up',
    );
    bits.push(`${m.specificity.level}`);
    const named = [
      ...m.specificity.files.slice(0, 6),
      ...m.specificity.lines.slice(0, 3),
      ...m.specificity.commands.slice(0, 2).map((c) => `\`${c}\``),
    ];
    if (named.length > 0) bits.push(`names ${named.join(', ')}`);
    if (m.correction.is) bits.push(`correction (${m.correction.signals.join(', ')})`);
    if (m.chips.length > 0) bits.push(`chips ${m.chips.map((c) => `${c.kind}:${c.name}`).join(', ')}`);
    if (m.gapMs !== null && m.kind !== 'queued') bits.push(`${seconds(m.gapMs)} after pi stopped`);
    bits.push(`${m.toolCalls} tool calls followed`);
    out.push(`${m.n}. [${bits.join('; ')}] ${clip(m.text, messageChars)}`);
    for (const c of m.review.slice(0, 12))
      out.push(
        `   review comment on ${c.file}:${c.line}${c.endLine && c.endLine > c.line ? `-${c.endLine}` : ''}: ${clip(c.text, 200)}`,
      );
    if (m.review.length > 12) out.push(`   (${m.review.length - 12} more review comments)`);
    for (const a of m.answers)
      out.push(
        `   dialog answer (${a.method}${a.title ? `: ${clip(a.title, 80)}` : ''}): ${a.status === 'cancelled' ? 'dismissed' : a.value !== undefined ? clip(a.value, 80) : a.confirmed === false ? 'deny' : 'allow'}`,
      );
    if (m.files.length > 0)
      out.push(
        `   pi then changed: ${m.files.slice(0, 12).join(', ')}${m.files.length > 12 ? ` and ${m.files.length - 12} more` : ''}`,
      );
  }
  out.push('', '## Files in the outcome');
  for (const f of ledger.files.filter((x) => x.inDiff)) {
    const bits = [];
    if (f.piTouched) bits.push(`pi edited it${f.piTouched.turn ? ` first in turn ${f.piTouched.turn}` : ''}`);
    else bits.push('pi never edited it; changed outside pi');
    if (f.named.length > 0) bits.push(`named by message ${f.named.join(', ')}`);
    if (f.reviewed.length > 0)
      bits.push(
        `review comment${f.reviewed.length > 1 ? 's' : ''} in message ${[...new Set(f.reviewed.map((r) => r.n))].join(', ')}`,
      );
    out.push(`- ${f.path}: ${bits.join('; ')}`);
  }
  const t = ledger.totals;
  out.push(
    '',
    `## Totals`,
    `${t.messages} messages, ${t.corrections} corrections, ${t.reviewComments} review comments, ${t.dialogAnswers} dialog answers, ${t.chips} skill chips, ${t.unattendedTurns} unattended turns, ${t.toolCalls} tool calls (${t.toolCallsPerMessage} per message), ${t.handEditedInOutcome} files of the outcome changed outside pi.`,
  );
  return out.join('\n');
}
