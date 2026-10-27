// Writes a long synthetic pi session for performance work:
//
//   node scripts/gen-big-session.mjs --agent-dir <dir> --cwd <project folder> [--turns 520] [--name "Big session, 520 turns"] [--fork-every 40] [--forks 12]
//
// Every turn is a user message and an assistant answer (markdown, a code block now and then); every 12th turn the assistant also
// calls the `read` tool and gets its result, and the file holds a compaction in the middle and `--forks` (twelve) short side branches, like the
// session it generalises. The file goes where pi looks for sessions of `--cwd` under `--agent-dir`, so a backend started
// with PI_CODING_AGENT_DIR=<dir> lists it as a thread.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'agent-dir': { type: 'string' },
    cwd: { type: 'string' },
    turns: { type: 'string', default: '520' },
    name: { type: 'string' },
    'fork-every': { type: 'string', default: '40' },
    forks: { type: 'string', default: '12' },
  },
});
if (!values['agent-dir'] || !values.cwd) {
  console.error('Usage: node scripts/gen-big-session.mjs --agent-dir <dir> --cwd <folder> [--turns N] [--name text]');
  process.exit(2);
}
const turns = Number(values.turns);
const cwd = resolve(values.cwd);
const name = values.name ?? `Big session, ${turns} turns`;
const sid = randomUUID();
const t0 = Date.parse('2026-10-15T09:00:00.000Z');
const iso = (i) => new Date(t0 + i * 20_000).toISOString();
const hex = () => randomBytes(4).toString('hex');
const entries = [];
let n = 0;
function add(type, parentId, extra) {
  n += 1;
  const entry = { type, id: hex(), parentId, timestamp: iso(n), ...extra };
  entries.push(entry);
  return entry.id;
}
const usage = (tokens) => ({ input: tokens, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 80, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (parent, text) => add('message', parent, { message: { role: 'user', content: [{ type: 'text', text }], timestamp: n * 1000 } });
const assistant = (parent, content, stopReason = 'stop') =>
  add('message', parent, { message: { role: 'assistant', content, api: 'openai-completions', provider: 'llama-swap', model: 'gemma-4-26b', usage: usage(300 + n), stopReason, timestamp: n * 1000 } });

const answer = (i) =>
  `Answer ${i}. Module ${i % 37} keeps its state in a small store; the relevant part is:\n\n\`\`\`ts\nexport function step${i}(input: number): number {\n  return input * ${i % 7 + 2} + ${i};\n}\n\`\`\`\n\nThe function is pure, so it is safe to call from the reducer. **Next:** check the callers in \`src/module${i % 37}.ts\`.`;

add('model_change', null, { provider: 'llama-swap', modelId: 'gemma-4-26b' });
let parent = add('message', entries[0].id, { message: { role: 'system', content: '', timestamp: 0 } });
const forkPoints = [];
for (let i = 1; i <= turns; i++) {
  const u = user(parent, `Turn ${i}: question about module ${i % 37}`);
  if (i % 12 === 0) {
    const callId = `call_${i}`;
    const a1 = assistant(u, [{ type: 'text', text: `Let me look at module ${i % 37}.` }, { type: 'toolCall', id: callId, name: 'read', arguments: { path: `src/module${i % 37}.ts` } }], 'toolUse');
    const r = add('message', a1, { message: { role: 'toolResult', toolCallId: callId, toolName: 'read', content: [{ type: 'text', text: `export const module${i % 37} = ${i};\n`.repeat(6) }], isError: false, timestamp: n * 1000 } });
    parent = assistant(r, [{ type: 'text', text: answer(i) }]);
  } else {
    parent = assistant(u, [{ type: 'text', text: answer(i) }]);
  }
  if (i % Number(values['fork-every']) === 0) forkPoints.push(parent);
  if (i === Math.floor(turns / 2)) parent = add('compaction', parent, { summary: 'Summary of the first half of the conversation.', firstKeptEntryId: u, tokensBefore: 120_000 });
}
const mainLength = entries.length;
for (const [k, point] of forkPoints.slice(0, Number(values.forks)).entries()) {
  let p = point;
  for (let j = 0; j < 2; j++) p = assistant(user(p, `Side ${k}.${j}: alternative approach`), [{ type: 'text', text: 'alt' }]);
}
// The leaf pi opens is the file's last entry: put the side branches before the end of the main path.
const side = entries.slice(mainLength);
const main = entries.slice(0, mainLength);
const ordered = [...main.slice(0, -4), ...side, ...main.slice(-4)];

const dir = join(resolve(values['agent-dir']), 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
mkdirSync(dir, { recursive: true });
const file = join(dir, `${iso(0).replace(/:/g, '-')}_${sid}.jsonl`);
const lines = [{ type: 'session', version: 3, id: sid, timestamp: iso(0), cwd }, ...ordered, { type: 'session_info', id: hex(), parentId: main.at(-1).id, timestamp: iso(n + 1), name }];
writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`${file}\n${lines.length} entries, ${turns} turns, session ${sid}`);
