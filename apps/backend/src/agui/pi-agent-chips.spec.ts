import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { PiSessionService } from '../pi/pi-session.service';
import type { ChipResources } from './chip-expansion';
import { PiAgent } from './pi-agent';

const pi = await import('@earendil-works/pi-coding-agent');
const root = `${dirname(fileURLToPath(import.meta.url))}/fixtures/skills`;
const resources: ChipResources = {
  skills: ['alpha', 'beta'].map((name) => ({ name, filePath: `${root}/${name}/SKILL.md`, baseDir: `${root}/${name}` })),
  templates: [{ name: 'greet', content: 'Greet $1 warmly.' }],
  read: (path) => readFileSync(path, 'utf8'),
  stripFrontmatter: pi.stripFrontmatter,
};

/** The pi session a run talks to, as far as a prompt needs it; it records what pi was given. */
function world(streaming = false) {
  const prompts: string[] = [];
  const queued: string[] = [];
  const entries: { chips: unknown[]; text: string }[] = [];
  const sessions = {
    open: async () => ({ cwd: '/work', model: { provider: 'p', modelId: 'm' }, thinkingLevel: 'off' }),
    isStreaming: () => streaming,
    chipResources: async () => resources,
    appendSkills: (_id: string, entry: { chips: unknown[]; text: string }) => {
      entries.push(entry);
      return 's1';
    },
    appendReview: () => 'r1',
    prompt: async (_id: string, text: string) => void prompts.push(text),
    steer: async (_id: string, text: string) => void queued.push(text),
    followUp: async (_id: string, text: string) => void queued.push(text),
    subscribe: () => () => undefined,
    onUiEvent: () => () => undefined,
    onDialogRequested: () => () => undefined,
    pendingDialogs: () => [],
    mcpAppLookup: () => undefined,
    takeAbortedWhileWaiting: () => false,
    leafId: () => 'l1',
    abort: vi.fn(),
  } as unknown as PiSessionService;
  const threads = { prepareRun: async () => ({ cwd: '/work', sessionPath: '/s.jsonl', title: undefined }), sessionOpened: () => undefined };
  const agent = new PiAgent(sessions, { defaultCwd: '/work', threads: threads as never, carry: new Map(), relayMcp: (async () => undefined) as never });
  const run = (text: string, forwardedProps: unknown): Promise<BaseEvent[]> =>
    firstValueFrom(agent.run({ threadId: 't1', runId: 'r1', messages: [{ id: 'u1', role: 'user', content: text } as Message], tools: [], context: [], state: {}, forwardedProps } as RunAgentInput).pipe(toArray()));
  return { prompts, queued, entries, run };
}

const chip = (kind: 'skill' | 'prompt', name: string, pinned = false) => ({ kind, name, pinned });

describe('PiAgent: skill and prompt-template chips', () => {
  it('prompts pi with one block per chip and then the sentence, and records the chips with the sentence as a session entry', async () => {
    const w = world();
    const events = await w.run('check the parser', { skills: [chip('skill', 'alpha'), chip('skill', 'beta', true)] });
    expect(w.prompts).toHaveLength(1);
    const [prompt] = w.prompts;
    expect(prompt.indexOf('<skill name="alpha"')).toBe(0);
    expect(prompt.indexOf('<skill name="beta"')).toBeGreaterThan(prompt.indexOf('</skill>'));
    expect(prompt.endsWith('</skill>\n\ncheck the parser')).toBe(true);
    expect(w.entries).toEqual([{ chips: [{ kind: 'skill', name: 'alpha', pinned: false }, { kind: 'skill', name: 'beta', pinned: true }], text: 'check the parser' }]);
    expect(events.find((e) => (e as { activityType?: string }).activityType === 'pi.skills')).toMatchObject({ messageId: 'skills:s1', content: { chips: [{ name: 'alpha' }, { name: 'beta' }] } });
  });

  it('gives one chip and no text exactly what /skill:name gave, and expands a template with the sentence as its arguments', async () => {
    const one = world();
    await one.run('', { skills: [chip('skill', 'alpha')] });
    const real = (pi.AgentSession.prototype as unknown as { _expandSkillCommand(this: unknown, text: string): string })._expandSkillCommand.call(
      { resourceLoader: { getSkills: () => ({ skills: resources.skills }) }, _extensionRunner: { emitError: () => undefined } },
      '/skill:alpha',
    );
    expect(one.prompts).toEqual([real]);
    const template = world();
    await template.run('Ada', { skills: [chip('prompt', 'greet')] });
    expect(template.prompts).toEqual(['Greet Ada warmly.']);
    expect(template.entries[0].text).toBe('Ada');
  });

  it('leaves a message without chips, or with malformed ones, exactly as typed: a leading /skill:name stays pi’s to expand', async () => {
    const plain = world();
    await plain.run('/skill:alpha say hi', undefined);
    expect(plain.prompts).toEqual(['/skill:alpha say hi']);
    expect(plain.entries).toEqual([]);
    const broken = world();
    await broken.run('hello', { skills: [{ kind: 'extension', name: 'x' }] });
    expect(broken.prompts).toEqual(['hello']);
    expect(broken.entries).toEqual([]);
  });

  it('expands the chips of a message queued while pi runs, without a session entry', async () => {
    const w = world(true);
    await w.run('and this', { streamingBehavior: 'steer', skills: [chip('skill', 'beta')] });
    expect(w.prompts).toEqual([]);
    expect(w.queued).toHaveLength(1);
    expect(w.queued[0].startsWith('<skill name="beta"')).toBe(true);
    expect(w.queued[0].endsWith('</skill>\n\nand this')).toBe(true);
    expect(w.entries).toEqual([]);
  });
});
