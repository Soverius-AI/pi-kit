// A hand-written pi session for the screenshots: a turn with a thinking block, a read, an edit
// that carries a patch, a bash run, and a markdown answer. Written as pi's own JSONL so the app replays it like any other thread.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const hex = () => randomBytes(4).toString('hex');

export function writeReportingSession({ agentDir, cwd, name = 'Add a monthly summary to the reporting module' }) {
  const sid = `0000a111-${hex()}-4000-8000-${randomBytes(6).toString('hex')}`;
  const t0 = Date.parse('2026-10-15T09:00:00.000Z');
  const entries = [];
  let n = 0;
  const stamp = () => new Date(t0 + ++n * 7000).toISOString();
  const add = (type, parentId, extra) => {
    const entry = { type, id: hex(), parentId, timestamp: stamp(), ...extra };
    entries.push(entry);
    return entry.id;
  };
  const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const user = (parent, text) => add('message', parent, { message: { role: 'user', content: [{ type: 'text', text }], timestamp: t0 + n * 7000 } });
  const assistant = (parent, content, stopReason, tokens) =>
    add('message', parent, { message: { role: 'assistant', content, api: 'openai-completions', provider: 'llama-swap', model: 'gemma-4-26b', usage: usage(tokens, 120), stopReason, timestamp: t0 + n * 7000, durationMs: 5200 } });
  const result = (parent, id, toolName, text, details = undefined) =>
    add('message', parent, { message: { role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text }], isError: false, ...(details ? { details } : {}), durationMs: 41, timestamp: t0 + n * 7000 } });

  let parent = add('model_change', null, { provider: 'llama-swap', modelId: 'gemma-4-26b' });
  parent = add('thinking_level_change', parent, { thinkingLevel: 'medium' });
  parent = add('message', parent, { message: { role: 'system', content: '', timestamp: t0 } });
  parent = user(parent, 'Add a mul function to src/math.ts, like add and sub, and tell me what you changed.');
  parent = assistant(
    parent,
    [
      { type: 'thinking', thinking: 'The user wants a mul function next to add and sub.\n\nI should read src/math.ts first to match its style, then add the function at the end and keep the exports consistent.\n\nAfter the edit I will run the tests to be sure nothing else moved.', thinkingSignature: 'reasoning_content' },
      { type: 'text', text: 'I will read the module first so the new function matches the others.' },
      { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'src/math.ts' } },
    ],
    'toolUse',
    1840,
  );
  parent = result(parent, 'call_read', 'read', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n');
  parent = assistant(parent, [{ type: 'toolCall', id: 'call_edit', name: 'edit', arguments: { path: 'src/math.ts', edits: [{ oldText: '  return a - b;\n}\n', newText: '  return a - b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n' }] } }], 'toolUse', 2210);
  parent = result(parent, 'call_edit', 'edit', 'Successfully replaced 1 block in src/math.ts.', {
    patch: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -4,3 +4,7 @@\n \n export function sub(a: number, b: number): number {\n   return a - b;\n }\n+\n+export function mul(a: number, b: number): number {\n+  return a * b;\n+}\n',
  });
  parent = assistant(parent, [{ type: 'toolCall', id: 'call_bash', name: 'bash', arguments: { command: 'npx tsc --noEmit src/math.ts && echo typecheck ok' } }], 'toolUse', 2390);
  parent = result(parent, 'call_bash', 'bash', 'typecheck ok\n');
  parent = assistant(
    parent,
    [{ type: 'text', text: 'I added `mul` to `src/math.ts`, after `sub`:\n\n```ts\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n```\n\n- It follows the same shape as `add` and `sub`: two numbers in, one number out.\n- The file still type checks (`tsc --noEmit` is clean).\n\nNothing else in the project referenced the module, so no other file changed.' }],
    'stop',
    2650,
  );
  parent = user(parent, 'Thanks. Could you also export a `div` that refuses to divide by zero?');
  parent = assistant(parent, [{ type: 'text', text: 'Yes. I would throw a `RangeError` for a zero divisor rather than return `Infinity`, so callers cannot miss it. Say the word and I will add it.' }], 'stop', 2800);
  add('session_info', parent, { name });

  const dir = join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date(t0).toISOString().replace(/:/g, '-')}_${sid}.jsonl`);
  const lines = [{ type: 'session', version: 3, id: sid, timestamp: new Date(t0).toISOString(), cwd }, ...entries];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, id: sid, name };
}

/**
 * A short session whose last response had `contextTokens` in context (so the meter shows that fill) and whose requests carry known
 * usage and cost, for the usage tests and screenshots: two turns, `compaction: true` adds a compaction between them. The numbers to
 * expect in the usage dialog: turn 1 is in 1000 / out 100, $0.01; turn 2 is in `contextTokens` / out 200 / cache read 500, $0.03.
 */
export function writeUsageSession({ agentDir, cwd, name, contextTokens, compaction = false, model = 'gemma-4-26b' }) {
  const sid = `0000b222-${hex()}-4000-8000-${randomBytes(6).toString('hex')}`;
  const t0 = Date.now() - 3_600_000;
  const entries = [];
  let n = 0;
  const stamp = () => new Date(t0 + ++n * 2000).toISOString();
  const add = (type, parentId, extra) => {
    const entry = { type, id: hex(), parentId, timestamp: stamp(), ...extra };
    entries.push(entry);
    return entry.id;
  };
  const usage = (input, output, cacheRead, cost) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
  const assistant = (parent, text, u) =>
    add('message', parent, { message: { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'llama-swap', model, usage: u, stopReason: 'stop', timestamp: t0 } });
  const user = (parent, text) => add('message', parent, { message: { role: 'user', content: [{ type: 'text', text }], timestamp: t0 } });
  let parent = add('model_change', null, { provider: 'llama-swap', modelId: model });
  parent = add('thinking_level_change', parent, { thinkingLevel: 'off' });
  parent = user(parent, 'First question for the usage numbers.');
  parent = assistant(parent, 'First answer.', usage(1000, 100, 0, 0.01));
  if (compaction) parent = add('compaction', parent, { summary: 'Earlier turns, summarised.', firstKeptEntryId: parent, tokensBefore: 180_000 });
  parent = user(parent, 'Second question, after the context grew.');
  parent = assistant(parent, 'Second answer.', usage(contextTokens, 200, 500, 0.03));
  add('session_info', parent, { name });
  const dir = join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date(t0).toISOString().replace(/:/g, '-')}_${sid}.jsonl`);
  const lines = [{ type: 'session', version: 3, id: sid, timestamp: new Date(t0).toISOString(), cwd }, ...entries];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, id: sid, name };
}
