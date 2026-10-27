// A model that answers with a canned text: an OpenAI-compatible chat-completions server on a free local port, for the attendant to talk to. The tests register it as a
// provider in the scratch agent folder (`registerFakeModel`) and choose it in Settings › Attendant, so the whole path runs for real (the attendant's pi session, the HTTP request,
// the streamed answer, the cost accounting) and the answer is the test's. It records every request so a test can look at what the model was sent.
//
// A second use: a thread's own model. `answer` may return `{ text, toolCalls }`, and `notesAgent` is a small deterministic agent that writes the notes a prompt names
// with pi's `write` tool and runs the check command the prompt names with `bash`, so a thread can run to the end without a language model, and a replay of it can be compared with it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const FAKE_PROVIDER = 'learn-fake';
export const FAKE_MODEL = 'canned';

/** A skill for the notes tasks: `name` is its name; `first` is step 1, the line a test changes to make a different skill. */
export function cannedSkill({ name = 'add-notes-with-an-index', first = '1. Create each note in its own file under the notes folder, one tool call per file.' } = {}) {
  return `---
name: ${name}
description: Use when adding several short notes to a project and keeping an index of them
---

# Add notes with an index

## When to use
When a task asks for a set of small markdown notes that belong together.

## Steps
${first}
2. Give every note the same three lines: a heading, a line of text and a line saying which note it is.
3. Check the folder listing before you say you are done.

## Pitfalls
- Writing all the notes into one file: the next person looks for one file per note.

## Verify
- \`ls notes\` lists one file per note.
`;
}

/** The skill the fake model drafts: a small, valid SKILL.md. */
export const CANNED_SKILL = cannedSkill();

const textOfContent = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n'));

/** The text of the first user message of a request (what a thread was asked), skill blocks and all. */
export const firstUserMessage = (body) => textOfContent((body.messages ?? []).find((m) => m.role === 'user')?.content);

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * A deterministic agent for the notes tasks, as an `answer` function. It reads the thread's first user message:
 *  - the files are the `notes/<name>.md` paths in the prompt, and each gets three lines ("# Note N", "A short note.", "Note N of <count>.") with one `write` call each, all in one turn;
 *  - a command in backticks that starts with `node --test` in the prompt is run with `bash` in the next turn;
 *  - then it says it is done.
 * A skill block in the message (a pinned skill) can only narrow the work: "first five notes only" in the skill limits it to five files. A prompt with "take your time" makes it wait
 * `slowMs` before it answers, so a test can stop a run that is under way. Requests that are not for a thread (a learn prompt) are the caller's to answer.
 */
export function notesAgent(body, { slowMs = 20_000 } = {}) {
  const first = firstUserMessage(body);
  const skill = /<skill [^>]*>([\s\S]*?)<\/skill>/.exec(first)?.[1] ?? '';
  const prompt = first.replace(/<skill [^>]*>[\s\S]*?<\/skill>\s*/g, '');
  const named = [...new Set(prompt.match(/notes\/[a-z0-9-]+\.md/g) ?? [])];
  let files = named;
  const limit = /first (\w+) notes only/i.exec(skill)?.[1];
  if (limit) files = files.slice(0, NUMBER_WORDS[limit.toLowerCase()] ?? Number(limit));
  const check = /`(node --test[^`]*)`/.exec(prompt)?.[1];
  const turns = (body.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
  const reply = (value) => (/take your time/i.test(prompt) && turns === 0 ? new Promise((resolve) => setTimeout(() => resolve(value), slowMs)) : value);
  if (turns === 0 && files.length > 0) {
    return reply({
      toolCalls: files.map((path, i) => ({
        name: 'write',
        // "of N" counts the notes the prompt names, so a skill that does fewer of them leaves the ones it does exactly as they were.
        arguments: { path, content: `# Note ${i + 1}\nA short note.\nNote ${i + 1} of ${named.length}.\n` },
      })),
    });
  }
  if (turns <= 1 && check && turns === (files.length > 0 ? 1 : 0)) return { toolCalls: [{ name: 'bash', arguments: { command: check } }] };
  return 'Done.';
}

/**
 * Starts the server. `answer(request)` returns text (default: the canned skill), or `{ text?, reasoning?, reasoningMs?, toolCalls?: [{ name, arguments }] }`; it may be async.
 * `requests` collects the parsed request bodies, newest last.
 * @param {{ answer?: (body: object) => string | { text?: string, reasoning?: string, reasoningMs?: number, toolCalls?: { name: string, arguments: object }[] } | Promise<unknown>, port?: number }} [options]
 */
export async function startFakeModel({ answer = () => CANNED_SKILL, port = 0 } = {}) {
  const requests = [];
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: FAKE_MODEL, object: 'model' }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // not JSON: answer anyway
      }
      requests.push(body);
      const given = await answer(body);
      // A run that was stopped while the answer was slow has closed its side already.
      if (res.destroyed || res.socket?.destroyed) return;
      const text = typeof given === 'string' ? given : (given?.text ?? '');
      const reasoning = typeof given === 'string' ? '' : (given?.reasoning ?? '');
      const toolCalls = typeof given === 'string' ? [] : (given?.toolCalls ?? []).map((call, i) => ({ id: `call_${++calls}_${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } }));
      const size = text.length + reasoning.length + toolCalls.reduce((n, c) => n + c.function.arguments.length, 0);
      const usage = { prompt_tokens: 120, completion_tokens: Math.max(1, Math.ceil(size / 4)), total_tokens: 120 + Math.ceil(size / 4) };
      const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: FAKE_MODEL };
      const finish = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (payload) => res.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`);
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        if (reasoning) {
          send({ choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] });
          if (given.reasoningMs) await new Promise((resolve) => setTimeout(resolve, given.reasoningMs));
          if (res.destroyed || res.socket?.destroyed) return;
        }
        for (let i = 0; i < text.length; i += 80) {
          if (res.destroyed || res.socket?.destroyed) return;
          send({ choices: [{ index: 0, delta: { content: text.slice(i, i + 80) }, finish_reason: null }] });
          if (typeof given !== 'string' && given?.chunkMs) await new Promise((resolve) => setTimeout(resolve, given.chunkMs));
        }
        if (toolCalls.length > 0) send({ choices: [{ index: 0, delta: { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage }));
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  return {
    url: `http://127.0.0.1:${bound}/v1`,
    requests,
    /** The text of the last user message of the newest request. */
    lastPrompt() {
      const messages = requests.at(-1)?.messages ?? [];
      const user = [...messages].reverse().find((m) => m.role === 'user');
      return textOfContent(user?.content);
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Adds the fake model as a provider of the agent folder's `models.json` (the other providers stay), so pi can use `learn-fake/canned`. */
export function registerFakeModel(agentDir, url) {
  const file = join(agentDir, 'models.json');
  const models = JSON.parse(readFileSync(file, 'utf8'));
  // A price per million tokens, so what a thread or a background agent spent is a number the tests can look at (UC-10).
  models.providers[FAKE_PROVIDER] = { baseUrl: url, api: 'openai-completions', apiKey: 'fake', models: [{ id: FAKE_MODEL, name: 'Canned draft', contextWindow: 32768, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] };
  writeFileSync(file, JSON.stringify(models, null, 2));
}

/** The text of the last user message of a request body. */
export function userTextOf(body) {
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  if (typeof user?.content === 'string') return user.content;
  return (user?.content ?? []).map((part) => part.text ?? '').join('\n');
}

/** Is this request the Meat Proxy Score's attribution prompt (packages/pi-kit-meat-proxy/prompts/attribute.md)? */
export const isScorePrompt = (body) => JSON.stringify(body.messages?.[0] ?? '').includes('You attribute the changes');

/**
 * The labels the fake model gives the hunks of an attribution prompt, one line per `hN | file | @@ ...` it was shown, by rules about the files of the Meat Proxy tests:
 * notes/alpha.md was changed by a review comment (corrected, traced to the message that carried it), notes/beta.md was named by the first prompt (specified), notes/index.md was
 * nobody's idea (autonomous), and any file the person already corrected in this thread's earlier labels (the prompt lists those) is specified.
 */
export function cannedLabels(prompt) {
  const lines = prompt.split('\n');
  // The message that carried the review comments: the numbered line above "review comment on ...".
  let review = 2;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+review comment on /.test(lines[i])) continue;
    for (let j = i - 1; j >= 0; j--) {
      const m = /^(\d+)\. \[/.exec(lines[j]);
      if (m) {
        review = Number(m[1]);
        break;
      }
    }
    break;
  }
  const corrected = new Set([...prompt.matchAll(/^- (\S+) @@[^\n]*the person says (specified|corrected|manual)/gm)].map((m) => m[1]));
  const out = [];
  for (const line of lines) {
    const hunk = /^(h\d+) \| (\S+) \| @@/.exec(line);
    if (!hunk) continue;
    const [, key, file] = hunk;
    if (corrected.has(file)) out.push(`${key} | specified | prompt 2 | you said so`);
    else if (file === 'notes/alpha.md') out.push(`${key} | corrected | review ${review} | the review comment asked for this wording`);
    else if (file === 'notes/beta.md') out.push(`${key} | specified | prompt 1 | the first prompt named this file`);
    else out.push(`${key} | autonomous | none | nobody asked for this`);
  }
  return out.join('\n');
}
