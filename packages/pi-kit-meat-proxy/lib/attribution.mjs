// The attribution of @pi-kit/meat-proxy: the prompt that asks the attendant's model to label every hunk of the outcome diff, and the reading of its answer. Plain ESM with
// no dependencies, so the pi extension and pi-kit's backend (which scores after an outcome without a pi session) use the same file. It calls no model: the call goes through
// `pi-kit:attendant:run`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerptOf, weightOf } from './hunks.mjs';
import { LABELS } from './score.mjs';
import { ledgerToText } from './ledger.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A prompt-batching target, never a cutoff: subsequent requests receive every remaining hunk. */
const HUNK_BATCH_CHARS = 60_000;
const BODY_LINES = 24;
const LINE_WIDTH = 160;

/** The system and the user text of the attribution prompt, from `prompts/attribute.md`. */
export function loadPrompt(file = readFileSync(join(root, 'prompts', 'attribute.md'), 'utf8')) {
  const [, afterSystem = ''] = file.split('<!-- system -->');
  const [system = '', user = ''] = afterSystem.split('<!-- user -->');
  return { system: system.trim(), user: user.trim() };
}

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Which hunks the model is shown (named `h1`, `h2`, ...) and which are decided without it. */
function planHunks(hunks, ledger) {
  const handOnly = new Set(ledger.handOnly);
  const shown = [];
  const byRule = [];
  for (const hunk of hunks) {
    if (handOnly.has(hunk.file)) {
      byRule.push(hunk);
      continue;
    }
    shown.push({ key: `h${shown.length + 1}`, hunk });
  }
  return { shown, byRule };
}

/** Preserve diff order while batching preview text; hand-only hunks require no model context. */
export function* attributionBatches(hunks, ledger) {
  const handOnly = new Set(ledger.handOnly);
  let batch = [];
  let chars = 0;
  for (const hunk of hunks) {
    const size = handOnly.has(hunk.file) ? 0 : hunkText(hunk).length;
    if (batch.length && chars + size > HUNK_BATCH_CHARS) {
      yield batch;
      batch = [];
      chars = 0;
    }
    batch.push(hunk);
    chars += size;
  }
  if (batch.length) yield batch;
}

function hunkText(hunk, key = '') {
  const changed = hunk.lines.filter((l) => l[0] === '+' || l[0] === '-');
  const cut = changed.slice(0, BODY_LINES).map((l) => `  ${l.length > LINE_WIDTH ? `${l.slice(0, LINE_WIDTH - 1)}…` : l}`);
  if (changed.length > BODY_LINES) cut.push(`  … ${changed.length - BODY_LINES} more changed lines`);
  return `${key ? `${key} | ` : ''}${hunk.file} | ${hunk.header}${hunk.section ? ` ${hunk.section}` : ''} | +${hunk.added} -${hunk.removed}\n${cut.join('\n')}`;
}

/** The person's earlier corrections of this thread's labels, as examples for the next prompt (`stored` is `thread_outcomes.hunk_labels`). */
export function examplesText(stored) {
  const corrections = Object.values(stored?.corrections ?? {}).slice(-12);
  if (corrections.length === 0) return '';
  const lines = corrections.map((c) => `- ${c.file} ${c.header}${c.excerpt?.length ? ` (${c.excerpt.slice(0, 2).map((l) => clip(l, 70)).join(' / ')})` : ''}: the model said ${c.was}, the person says ${c.label}`);
  return `## The person corrected earlier labels of this thread\nTreat these as ground truth and judge similar hunks the same way.\n${lines.join('\n')}\n\n`;
}

/** `{ system, user, plan }` for the model; `plan.shown` maps the names the model answers with to hunks. */
export function buildAttributionPrompt({ ledger, hunks, stored }, file) {
  const plan = planHunks(hunks, ledger);
  const prompt = loadPrompt(file);
  const listing = plan.shown.map(({ key, hunk }) => hunkText(hunk, key)).join('\n\n') || '(no hunks to label)';
  const notes = [];
  if (plan.byRule.length > 0) notes.push(`${plan.byRule.length} hunks in files only the person changed by hand are labelled manual without you and are not listed.`);
  const user = prompt.user
    .replace('{{ledger}}', () => ledgerToText(ledger))
    .replace('{{examples}}', () => examplesText(stored))
    .replace('{{hunks}}', () => `${notes.length > 0 ? `${notes.join(' ')}\n\n` : ''}${listing}`);
  return { system: prompt.system, user, plan };
}

const LABEL_WORD = new RegExp(`\\b(${LABELS.join('|')})\\b`, 'i');

/** The input a model names (`prompt 2`, `review 3`, `hand`, `none`, ...) as `{ input, turn }`. */
export function parseInput(text) {
  const word = String(text ?? '').trim().toLowerCase();
  const turn = /(\d+)/.exec(word);
  const n = turn ? Number(turn[1]) : undefined;
  if (/^(?:prompt|message|msg|turn)\b/.test(word)) return n === 1 ? { input: 'first-prompt', turn: 1 } : { input: 'follow-up', ...(n ? { turn: n } : {}) };
  if (/^review/.test(word)) return { input: 'review', ...(n ? { turn: n } : {}) };
  if (/^(?:hand|manual|by hand)/.test(word)) return { input: 'hand' };
  if (/^(?:dialog|answer|question)/.test(word)) return { input: 'dialog', ...(n ? { turn: n } : {}) };
  if (/^(?:chip|skill)/.test(word)) return { input: 'chip', ...(n ? { turn: n } : {}) };
  return { input: 'none' };
}

/**
 * Reads the model's answer: one line per hunk, `h3 | specified | prompt 1 | reason`. Returns `{ labels, missing, unknown }`: `labels` by hunk key, the keys the model skipped, and
 * lines that named no hunk of the list. Bullets, bold marks, a code fence around the whole answer and `:` instead of `|` are tolerated.
 */
export function parseAttribution(reply, keys) {
  const labels = new Map();
  const wanted = new Set(keys);
  const unknown = [];
  for (const raw of String(reply ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/[*`]/g, '').trim();
    if (!line || line.startsWith('```')) continue;
    const head = /^(h\d+)\s*([|:\-–])?\s*(.*)$/i.exec(line);
    if (!head) continue;
    const key = head[1].toLowerCase();
    if (!wanted.has(key)) {
      unknown.push(line);
      continue;
    }
    const fields = head[3].split('|').map((f) => f.trim());
    const wordMatch = LABEL_WORD.exec(fields[0] ?? '') ?? LABEL_WORD.exec(head[3]);
    if (!wordMatch) continue;
    const label = wordMatch[1].toLowerCase();
    const second = fields.length > 1 ? fields[1] : '';
    const parsed = parseInput(second);
    labels.set(key, { label, ...parsed, reason: clip(fields.slice(2).join(' | '), 200) });
  }
  return { labels, missing: keys.filter((k) => !labels.has(k)), unknown };
}

/** The input a label implies when the model named none that fits (so a steered hunk always traces to something). */
function settle(label, parsed, ledger, file) {
  let { input } = parsed;
  const { turn } = parsed;
  if (label === 'autonomous') return { input: 'none' };
  if (label === 'manual') return { input: 'hand' };
  if (input === 'none' || input === 'hand') {
    const entry = ledger.files.find((f) => f.path === file);
    const review = entry?.reviewed[0];
    if (label === 'corrected' && review) return { input: 'review', turn: review.n };
    const named = entry?.named[0];
    if (named) return { input: named === 1 ? 'first-prompt' : 'follow-up', turn: named };
    return { input: label === 'corrected' ? 'follow-up' : 'first-prompt', turn: label === 'corrected' ? undefined : 1 };
  }
  if (label === 'corrected' && input === 'first-prompt') input = 'follow-up';
  return { input, turn };
}

/**
 * Complete attribution entries in diff order: model labels plus manual-by-rule entries for hand-only files. Missing model labels are refused.
 */
export function buildLabelEntries({ plan, parsed, ledger, hunks }) {
  const shownKey = new Map(plan.shown.map(({ key, hunk }) => [hunk.id, key]));
  const entry = (hunk, fields) => ({
    id: hunk.id,
    file: hunk.file,
    header: hunk.header,
    lines: weightOf(hunk),
    excerpt: excerptOf(hunk),
    ...fields,
  });
  const out = [];
  const all = [...plan.byRule.map((h) => ({ h, how: 'rule' })), ...plan.shown.map(({ hunk }) => ({ h: hunk, how: 'shown' }))];
  for (const { h, how } of all) {
    if (how === 'rule') {
      const edit = ledger.files.find((f) => f.path === h.file)?.byHand;
      out.push(entry(h, { label: 'manual', input: 'hand', trace: `changed by hand outside pi${edit ? ` (${edit.count} change${edit.count === 1 ? '' : 's'} seen)` : ''}; pi never edited this file`, by: 'ledger' }));
    } else {
      const got = parsed.labels.get(shownKey.get(h.id));
      if (!got) throw new Error(`The model did not label ${h.id}.`);
      const settled = settle(got.label, got, ledger, h.file);
      out.push(entry(h, { label: got.label, input: settled.input, ...(settled.turn ? { turn: settled.turn } : {}), trace: got.reason || (settled.input === 'none' ? 'nothing in the thread leads to it' : `message ${settled.turn ?? ''}`.trim()), by: 'model' }));
    }
  }
  // Back in diff order.
  const order = new Map(hunks.map((h, i) => [h.id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
