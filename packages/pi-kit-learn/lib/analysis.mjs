// The analysis of @pi-kit/learn: the prompt over a reduced, redacted transcript, and the reading of the model's answer. Plain ESM with no dependencies, so
// the same file is loaded by the pi extension (extensions/learn.ts, through pi's loader) and by pi-kit's backend, which drafts after an outcome without a pi session.
// Nothing here calls a model or touches a skills folder: the model call goes through pi-kit's `pi-kit:attendant:run`, the draft comes back through `pi-kit:learn:draft`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** The system and the user text of the analysis prompt, from `prompts/analyze.md`; `{{skeleton}}` is `templates/SKILL.md`. */
export function loadPrompt(files = { prompt: read('prompts/analyze.md'), skeleton: read('templates/SKILL.md') }) {
  const [, afterSystem = ''] = files.prompt.split('<!-- system -->');
  const [system = '', user = ''] = afterSystem.split('<!-- user -->');
  return { system: system.replace('{{skeleton}}', () => files.skeleton.trim()).trim(), user: user.trim() };
}

const line = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** The transcript of `pi-kit:thread:transcript` as the text the model reads. */
export function transcriptToText(t) {
  const out = [];
  out.push('## What the developer asked', ...(t.prompts.length ? t.prompts.map((p, i) => `${i === 0 ? 'First prompt' : `Follow-up ${i}`}: ${line(p)}`) : ['(no prompt)']));
  out.push('', `## What the agent did (${t.toolCalls} tool calls${t.truncated ? ', the list is cut' : ''})`);
  if (t.steps.length === 0) out.push('(no tool calls)');
  for (const step of t.steps) out.push(`${step.n}. ${step.tool}${step.target ? ` ${step.target}` : ''}${step.outcome === 'error' ? '  [failed]' : ''}`);
  if (t.errors.length > 0) {
    out.push('', '## Errors and how they were handled');
    for (const error of t.errors) {
      out.push(`- step ${error.step} (${error.tool}${error.target ? ` ${error.target}` : ''}): ${line(error.message)} ${error.recovered ? `-> recovered at step ${error.recoveredBy}` : '-> not recovered'}`);
    }
  }
  if (t.checks.length > 0) {
    out.push('', '## Checks that were run');
    for (const check of t.checks) out.push(`- ${check.command}  ${check.passed ? '[passed]' : '[failed]'}`);
  }
  if (t.commitMessage) out.push('', '## Commit message', t.commitMessage.trim());
  if (t.diff) out.push('', `## Final diff (${t.changedLines} changed lines)`, '```diff', t.diff.trim(), '```');
  else if (t.head) out.push('', '## Final diff', '(the diff could not be read, or the outcome changed no files)');
  else out.push('', '## Final diff', '(the thread has no outcome yet, so there is no final diff)');
  return out.join('\n');
}

/** `{ system, user }` for the model: the template over this transcript. */
export function buildAnalysisPrompt(transcript, files) {
  const prompt = loadPrompt(files);
  return { system: prompt.system, user: prompt.user.replace('{{transcript}}', () => transcriptToText(transcript)) };
}

/** A skill name from free text: lowercase letters, digits and single hyphens, at most 64 characters. */
export function slug(text) {
  return (
    String(text ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '') || undefined
  );
}

/**
 * Reads the model's answer: a `SKILL.md` (possibly inside a code fence or after a sentence of chatter), or `SKIP: reason`. Returns `{ ok: true, name, description, text }`,
 * `{ ok: false, skip: true, reason }` when the model found nothing to generalise, or `{ ok: false, reason }` when the answer is not a skill.
 */
export function parseDraftReply(reply) {
  let text = String(reply ?? '').replace(/\r\n/g, '\n').trim();
  const skip = /^skip\s*:\s*(.*)$/im.exec(text);
  if (skip && !text.includes('\n---\n') && !text.startsWith('---')) return { ok: false, skip: true, reason: skip[1].trim() || 'The model found nothing that generalises.' };
  const fenced = /```(?:markdown|md|yaml)?\n([\s\S]*?)\n```/.exec(text);
  if (fenced && /^---\s*\n/m.test(fenced[1])) text = fenced[1].trim();
  const start = text.search(/^---[ \t]*$/m);
  if (start < 0) return { ok: false, reason: 'The answer is not a SKILL.md: it has no frontmatter.' };
  text = text.slice(start);
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(text);
  if (!match) return { ok: false, reason: 'The frontmatter is not closed.' };
  const field = (key) => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1]);
    return found ? found[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  const description = field('description');
  if (!description) return { ok: false, reason: 'The skill has no description.' };
  const body = (match[2] ?? '').trim();
  if (!body) return { ok: false, reason: 'The skill has no instructions.' };
  const name = slug(field('name') ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? description);
  if (!name) return { ok: false, reason: 'The skill has no usable name.' };
  const quoted = /: |:$| #|^[-?:,[\]{}#&*!|>%@`]/.test(description) ? JSON.stringify(description) : description;
  return { ok: true, name, description, text: `---\nname: ${name}\ndescription: ${quoted}\n---\n\n${body}\n` };
}
