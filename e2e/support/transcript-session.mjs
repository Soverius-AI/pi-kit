// Generated mixed-height Pi history shared by browser and Electron viewport contracts. No model request or private history.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeTranscriptSession({ agentDir, cwd, title, count = 1200 }) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const entries = [{ type: 'session', version: 3, id, timestamp, cwd }];
  let parentId = null;
  for (let i = 0; i < count; i++) {
    const user = `u${i}`;
    const answer = `a${i}`;
    entries.push({ type: 'message', id: user, parentId, timestamp,
      message: { role: 'user', content: [{ type: 'text', text: `Viewport question ${i}` }], timestamp: Date.now() } });
    // Mixed row heights exercise measured layout rather than a fixed-height approximation.
    const text = `Viewport answer ${i}` + (i % 9 === 0 ? '\n\n' + 'A longer paragraph that wraps in the transcript. '.repeat(35) : '');
    entries.push({ type: 'message', id: answer, parentId: user, timestamp,
      message: { role: 'assistant', content: [...(i % 2 ? [{ type: 'thinking', thinking: 'Checking a short calculation.' }] : []), { type: 'text', text }], api: 'openai-completions', provider: 'llama-swap',
        model: 'gemma-4-26b', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { total: 0 } } } });
    parentId = answer;
  }
  entries.push({ type: 'session_info', id: 'name', parentId, timestamp, name: title });
  const dir = join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${timestamp.replace(/:/g, '-')}_${id}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { file, count, title };
}
