// The scripted model of the reference use case "Add `mul` and get it release-ready": one
// `answer(body)` serves the main agent and the background agents, which it tells apart by the `pikit-agent: <name>` line at the top
// of a background agent's system prompt (absent for the main agent). It picks the next step from the tool results in the request, as
// e2e/native-genui.e2e.mjs does. Steps a test must observe in between wait on named gates (`gate('tester:bash')`), promises the test releases with
// `release(name)`, so nothing depends on timing. The turns of UC-0 are the extension's (e2e/support/pk-bg-turn.ts). Tester asks
// the main agent two questions (one it answers, one it forwards to the user) and reviewer asks the user one (UC-4, UC-5, UC-8); reviewer
// tries a write it may not (UC-11) and messages tester (UC-6).
import { userTextOf } from './fake-model.mjs';

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n'));

/** The background agent a request comes from, by the first line of its system prompt; `undefined` for the main agent. */
export const agentOf = (body) => /^pikit-agent: (\S+)/m.exec(textOf((body.messages ?? []).find((m) => m.role === 'system')?.content))?.[1];

/** Replies of the main agent to the turns the test extension starts (UC-0). */
export const TURN_REPLIES = {
  message: 'The extension turn was answered.',
  user: 'The user turn was answered.',
};

export function createScript({ slowBash = false, gateReports = false } = {}) {
  const gates = new Map();
  /** A promise the model waits on before the step `name`; the test releases it. */
  const gate = (name) => {
    let entry = gates.get(name);
    if (!entry) {
      let release;
      const held = new Promise((resolve) => (release = resolve));
      entry = { held, release };
      gates.set(name, entry);
      if (open) entry.release();
    }
    return entry.held;
  };
  const release = (name) => {
    void gate(name);
    gates.get(name).release();
  };
  /** After the tests: every gate opens, so a failed test leaves no model request waiting and the fake model can stop. */
  let open = false;
  const releaseAll = () => {
    open = true;
    for (const name of gates.keys()) release(name);
  };

  /** The tool results since the last user message: how far a turn's work has come. */
  const results = (body) => {
    const messages = body.messages ?? [];
    return messages.slice(messages.findLastIndex((m) => m.role === 'user') + 1).filter((m) => m.role === 'tool');
  };
  /** The tool results of the whole conversation (a background agent's steps are counted over its run). */
  const allResults = (body) => (body.messages ?? []).filter((m) => m.role === 'tool');
  const tool = (name, args) => ({ toolCalls: [{ name, arguments: args }] });

  const main = async (body) => {
    const prompt = userTextOf(body);
    if (/from the extension/i.test(prompt)) return TURN_REPLIES.message;
    if (/as a user message/i.test(prompt)) return TURN_REPLIES.user;
    if (/^Report from agent/.test(prompt)) {
      if (gateReports) await gate('main:report'); // the crash test kills the backend while this answer is pending
      const reports = (body.messages ?? []).filter((m) => m.role === 'user' && /^Report from agent/.test(textOf(m.content)));
      return reports.length >= 2 ? 'Both agents are done.' : 'Noted the report.';
    }
    // UC-4: a question from an agent: answered when the main agent knows, forwarded to the user when it is their call.
    const question = /^Question from agent "(\S+)" \(agent (\S+), question (\S+)\): (.*)/.exec(prompt);
    if (question) {
      const [, , agent, id, text] = question;
      if (results(body).length > 0) return /bigint/.test(text) ? 'Answered tester.' : 'Forwarded to you.';
      if (/bigint/.test(text)) return tool('agent_reply', { agent, question: id, text: 'No, numbers only.' });
      return tool('agent_forward', { agent, question: id, note: 'Your call.' });
    }
    if (/^The user (answered|dismissed) agent/.test(prompt)) return 'Noted the answer.';
    if (/Add mul/.test(prompt)) {
      const done = results(body);
      if (done.length === 0) {
        return {
          toolCalls: [
            { name: 'agent_spawn', arguments: { name: 'tester', role: 'writes and runs the tests', permission: 'edit', brief: 'Write test/math.test.ts with node:test cases for add, sub, mul and greet of src/math.ts and src/greet.ts, then run `node --test test/*.test.ts` and report the result.' } },
            { name: 'agent_spawn', arguments: { name: 'reviewer', role: 'reviews the code', permission: 'read-only', brief: 'Review src/: read every file and report what you would change.' } },
          ],
        };
      }
      if (done.length === 2) return tool('edit', { path: 'src/math.ts', edits: [{ oldText: 'export function sub(a: number, b: number): number {\n  return a - b;\n}', newText: 'export function sub(a: number, b: number): number {\n  return a - b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}' }] });
      return 'Started tester and reviewer.';
    }
    return 'Ready.';
  };

  const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, mul } from '../src/math.ts';
import { greet } from '../src/greet.ts';

test('add', () => assert.equal(add(2, 3), 5));
test('sub', () => assert.equal(sub(5, 3), 2));
test('mul', () => assert.equal(mul(2, 3), 6));
test('greet', () => assert.equal(greet('Ann'), 'Hello, Ann'));
`;

  const tester = async (body) => {
    const done = allResults(body);
    // A command the restart interrupted (UC-7): run it again, as a model would.
    const last = done.at(-1);
    if (last && /interrupted/i.test(textOf(last.content))) return tool('bash', { command: slowBash ? 'sleep 8 && node --test test/*.test.ts' : 'node --test test/*.test.ts' });
    if (done.length === 0) return tool('write', { path: 'test/math.test.ts', content: TEST_FILE });
    if (done.length === 1) {
      await gate('tester:ask');
      return tool('ask', { question: 'Must mul accept bigint as well?', kind: 'main' });
    }
    if (done.length === 2) return tool('ask', { question: 'Should the tests cover negative numbers too?', kind: 'main' });
    if (done.length === 3) {
      await gate('tester:bash');
      // The crash test kills the backend while this command runs: it must take a while, with a child of its own.
      return tool('bash', { command: slowBash ? 'sleep 8 && node --test test/*.test.ts' : 'node --test test/*.test.ts' });
    }
    if (done.length >= 4 && !done.slice(4).length) return tool('report', { text: 'Tests for add, sub, mul and greet pass.' });
    if (done.length === 5 && /interrupted/i.test(textOf(done[3].content))) return tool('report', { text: 'Tests for add, sub, mul and greet pass.' });
    return 'Done.';
  };

  // UC-11: the read-only reviewer tries to write anyway (the user denies it); UC-6: it tells tester to cover greet too (agent_list, then agent_send).
  const reviewer = async (body) => {
    const done = allResults(body);
    if (done.length === 0) return tool('read', { path: 'src/greet.ts' });
    if (done.length === 1) {
      await gate('reviewer:ask');
      return tool('ask', { question: 'greet has no punctuation. Change the output to "Hello, Ann!"? It would break callers.', kind: 'user', choices: ['Keep as is', 'Change it'] });
    }
    if (done.length === 2) return tool('write', { path: 'src/greet.ts', content: 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n' });
    if (done.length === 3) return tool('agent_list', {});
    if (done.length === 4) {
      const tester = JSON.parse(textOf(done[3].content)).find((agent) => agent.name === 'tester');
      return tool('agent_send', { agent: tester.agentId, text: 'Cover greet too.', mode: 'steer' });
    }
    if (done.length === 5) {
      await gate('reviewer:report');
      return tool('report', { text: 'Reviewed src/. greet has no punctuation; otherwise fine.' });
    }
    return 'Done.';
  };

  const answer = async (body) => {
    const agent = agentOf(body);
    if (!agent) return main(body);
    if (agent === 'tester') return tester(body);
    if (agent === 'reviewer') return reviewer(body);
    return `No script for agent ${agent}.`;
  };
  return { answer, gate, release, releaseAll };
}
