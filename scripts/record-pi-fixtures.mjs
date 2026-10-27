// Records real pi SDK events into libs/shared/pi-adapter/fixtures/.
//
//   node scripts/record-pi-fixtures.mjs
//
// It drives the pi package directly: the fixtures must be
// what `session.subscribe()` really delivers, not what the docs say. It runs three tiny prompts in a
// scratch folder with an in-memory session (no file is written under ~/.pi) and needs a configured
// model in ~/.pi/agent.
//
// The recorded events are slimmed so the fixtures stay small and reviewable: cumulative `partial`
// and `message` snapshots on `message_update` are dropped, except the `partial` of `toolcall_start`
// (mapEvent reads the tool-call id from it), and the system prompt sections inside `agent_end`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'libs', 'shared', 'pi-adapter', 'fixtures');
mkdirSync(out, { recursive: true });

function slim(event) {
  if (event.type === 'message_update') {
    const { message: _message, ...rest } = event;
    const ev = { ...rest.assistantMessageEvent };
    if (ev.type !== 'toolcall_start') delete ev.partial;
    else ev.partial = { content: ev.partial?.content?.slice(0, ev.contentIndex + 1) };
    return { ...rest, assistantMessageEvent: ev };
  }
  if (event.type === 'agent_end') {
    return {
      ...event,
      messages: event.messages.map((m) => (m.role === 'system' ? { ...m, sections: undefined } : m)),
    };
  }
  return event;
}

async function record(name, cwd, run) {
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const events = [];
  session.subscribe((e) => events.push(slim(e)));
  try {
    await run(session, events);
    await session.waitForIdle();
  } finally {
    session.dispose();
  }
  writeFileSync(join(out, `${name}.json`), JSON.stringify(events, null, 1) + '\n');
  console.log(name, events.length, 'events');
}

const cwd = mkdtempSync(join(tmpdir(), 'pi-kit-fixture-'));
writeFileSync(join(cwd, 'note.txt'), 'hello pi-kit\n');

await record('tool-run', cwd, (s) =>
  s.prompt("Use the bash tool to run 'cat note.txt' and then tell me in one short sentence what it contains."),
);

await record('abort', cwd, async (s, events) => {
  const run = s.prompt('Write a long essay about the history of the compass, at least 40 paragraphs.');
  while (!events.some((e) => e.type === 'message_update')) await new Promise((r) => setTimeout(r, 50));
  await s.abort();
  await run.catch(() => undefined);
});

await record('queue', cwd, async (s, events) => {
  const run = s.prompt('Say the word one.');
  while (!events.some((e) => e.type === 'message_start' && e.message.role === 'assistant')) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await s.followUp('Now say the word two.');
  await run;
});

// A persisted session file for `sessionToMessages()`: a tool call, an answer, a second
// turn and a session name, written by the real SessionManager into a scratch session directory.
// The system prompt sections and tool declarations are dropped and the cwd is made generic.
{
  const sessionDir = mkdtempSync(join(tmpdir(), 'pi-kit-session-'));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });
  try {
    await session.prompt("Use the bash tool to run 'cat note.txt' and then tell me in one short sentence what it contains.");
    await session.waitForIdle();
    session.sessionManager.appendSessionInfo('Read the note');
    await session.prompt('Now say the word two.');
    await session.waitForIdle();
  } finally {
    session.dispose();
  }
  const file = readdirSync(sessionDir).find((f) => f.endsWith('.jsonl'));
  const lines = readFileSync(join(sessionDir, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const entry = JSON.parse(line);
      if (entry.type === 'session') entry.cwd = '/work/project';
      if (entry.message?.role === 'system') {
        entry.message = { ...entry.message, sections: undefined, toolsAdded: undefined, toolsRemoved: undefined };
      }
      return JSON.stringify(entry);
    });
  writeFileSync(join(out, 'session.jsonl'), lines.join('\n') + '\n');
  console.log('session', lines.length, 'lines');
}
