// A sample session with forks, written as pi's own JSONL for the screenshots and the checks: seven turns with
// tool calls, a compaction after turn 2, a label, a thinking-level change, a branch summary and two abandoned branches (A: two turns,
// summarised, the second close to the window's end; B: one turn). Context sizes are chosen so the rings show: the arc rises to 88 % before the
// compaction and starts low after it. The file's last entry is turn 7, so that is where pi (and the app) opens it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const hex = () => randomBytes(4).toString('hex');

export function writeGraphSession({ agentDir, cwd, name = 'Reporting module, AG-UI adapter' }) {
  const sid = `0000b222-${hex()}-4000-8000-${randomBytes(6).toString('hex')}`;
  const day = new Date();
  const at = (minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 40 + minutes, 0).toISOString();
  let minute = 0;
  const entries = [];
  const add = (type, parentId, extra, step = 0) => {
    minute += step;
    const entry = { type, id: hex(), parentId, timestamp: at(minute), ...extra };
    entries.push(entry);
    return entry.id;
  };
  const usage = (tokens, output = 160) => ({ input: tokens - output, output, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const user = (parent, text, step = 1) => add('message', parent, { message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } }, step);
  const level = { value: 'medium' };
  const assistant = (parent, content, tokens, stopReason = 'stop') =>
    add('message', parent, { message: { role: 'assistant', content, api: 'openai-completions', provider: 'llama-swap', model: 'gemma-4-26b', thinkingLevel: level.value, usage: usage(tokens), stopReason, timestamp: Date.now(), durationMs: 4200 } });
  const result = (parent, id, toolName) => add('message', parent, { message: { role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text: 'ok' }], isError: false, durationMs: 30, timestamp: Date.now() } });

  /** A turn: the user's message, an assistant message with its tool calls, their results, and the answer. */
  const turn = (parent, prompt, calls, answer, tokens, step = 1) => {
    let p = user(parent, prompt, step);
    if (calls.length > 0) {
      const ids = calls.map(() => `call_${hex()}`);
      p = assistant(p, [{ type: 'text', text: 'Working on it.' }, ...calls.map((c, i) => ({ type: 'toolCall', id: ids[i], name: c.name, arguments: c.args }))], tokens - 400, 'toolUse');
      calls.forEach((c, i) => {
        p = result(p, ids[i], c.name);
      });
    }
    return assistant(p, [{ type: 'text', text: answer }], tokens);
  };

  let p = add('model_change', null, { provider: 'llama-swap', modelId: 'gemma-4-26b' });
  p = add('thinking_level_change', p, { thinkingLevel: 'medium' });
  p = add('message', p, { message: { role: 'system', content: '', timestamp: Date.now() } });
  const t1 = turn(p, 'Map tool_execution events to AG-UI tool calls', [{ name: 'read', args: { path: 'libs/pi-adapter/src/map.ts' } }, { name: 'edit', args: { path: 'libs/pi-adapter/src/map.ts' } }], 'Mapped; tool_execution_start becomes TOOL_CALL_START.', 23_500);
  const t2 = turn(t1, 'Add tests per event type', [{ name: 'write', args: { path: 'libs/pi-adapter/src/tool-events.spec.ts' } }, { name: 'bash', args: { command: 'npx vitest run' } }], 'Seven specs, all green.', 231_000, 3);
  const compaction = add('compaction', t2, { summary: 'The adapter maps pi events to AG-UI events; tests for each event type exist.', firstKeptEntryId: t2, tokensBefore: 231_000 }, 1);
  const t3 = turn(compaction, 'Try the generator approach', [{ name: 'edit', args: { path: 'libs/pi-adapter/src/pi-agent.ts' } }], 'The generator version is in place.', 62_000, 4);
  // Branch A, abandoned: two turns, the second close to the window's end
  const a1 = turn(t3, 'Fix the generator typing', [{ name: 'edit', args: { path: 'libs/pi-adapter/src/pi-agent.ts' } }], 'Typing fixed.', 70_000, 2);
  const a2 = turn(a1, 'Run the specs against it', [{ name: 'bash', args: { command: 'npx vitest run' } }], 'Two specs fail on ordering.', 244_000, 2);
  // Back to turn 3 with a summary of what was left (pi writes it as the start of the new branch)
  const summary = add('branch_summary', t3, { fromId: a2, summary: '## Goal\nGenerator typing fixed, then abandoned for the Observable.\n\n## Progress\nTwo specs failed on event ordering.' }, 3);
  level.value = 'high';
  const t4 = turn(summary, 'Use an Observable instead of the generator', [{ name: 'edit', args: { path: 'libs/pi-adapter/src/pi-agent.ts' } }], 'Switched to an Observable.', 81_000, 2);
  const labelled = add('label', t4, { targetId: entries.find((e) => e.parentId === summary)?.id, label: 'good-path' });
  const t5 = turn(labelled, 'Wire the interrupt for dialogs', [{ name: 'edit', args: { path: 'libs/pi-adapter/src/pi-agent.ts' } }, { name: 'edit', args: { path: 'libs/pi-adapter/src/ui-bridge.ts' } }], 'Dialogs now interrupt the run.', 110_000, 4);
  const t6 = turn(t5, 'Add tests for it', [{ name: 'write', args: { path: 'libs/pi-adapter/src/interrupts.spec.ts' } }, { name: 'bash', args: { command: 'npx vitest run' } }], 'Three specs added.', 136_000, 6);
  // Branch B off turn 6, abandoned without a summary; the user went back to turn 6 and carried on
  turn(t6, 'Retry with a bigger model', [], 'Same result, no changes kept.', 64_000, 2);
  turn(t6, 'Run the whole suite once more', [{ name: 'bash', args: { command: 'npx vitest run' } }], 'All green, 3 passed.', 137_000, 2);
  add('session_info', entries.at(-1).id, { name });

  const dir = join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${at(0).replace(/:/g, '-')}_${sid}.jsonl`);
  const lines = [{ type: 'session', version: 3, id: sid, timestamp: at(0), cwd }, ...entries];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, id: sid, name };
}
