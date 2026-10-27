import { describe, expect, it } from 'vitest';
import { buildContextItems, groupContextItems } from './context-items';

describe('the context, piece by piece', () => {
  it('names the system prompt sections, the tools, the skill blocks, the summary and every message part, with pi\'s token estimate', () => {
    const summary = 'Earlier: the user asked for a migration.';
    const items = buildContextItems(
      [
        { role: 'system', content: 'You are pi.', sections: { rules: '<rules>\n- Be concise\n</rules>', 'git-guard': '<git-guard>never push</git-guard>', gone: null } },
        { role: 'user', content: `Context so far:\n${summary}` },
        { role: 'user', content: [{ type: 'text', text: '<skill name="add-a-migration">do it like this</skill>\nAdd the users table' }, { type: 'image' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'On it.' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] },
        { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'a.ts\nb.ts' }] },
        { role: 'custom', customType: 'pikit.agent-report', content: 'Report from agent "tester": done' },
      ],
      [{ name: 'bash', description: 'Run a command', parameters: { type: 'object' } }],
      [summary],
    );
    expect(items.map((item) => [item.kind, item.label, item.source, item.turn])).toEqual([
      ['tool', 'bash', 'tool:bash', null],
      ['system', 'System prompt', 'pi', null],
      ['system', 'Rules', 'pi', null],
      ['system', 'git-guard', 'extension:git-guard', null],
      ['summary', 'Compaction summary', 'compaction', 1],
      ['skill', 'add-a-migration', 'skill:add-a-migration', 2],
      ['user', 'Add the users table', 'user', 2],
      ['thinking', 'hmm', 'model', 2],
      ['assistant', 'On it.', 'model', 2],
      ['toolCall', 'bash', 'tool:bash', 2],
      ['toolResult', 'bash', 'tool:bash', 2],
      ['extension', 'pikit.agent-report', 'extension:pikit.agent-report', 2],
    ]);
    // An image counts as 4800 characters, as in pi's own estimate; a skill block's characters leave the message they were in.
    const user = items.find((item) => item.kind === 'user');
    expect(user?.chars).toBe(4800 + '\nAdd the users table'.length);
    expect(user?.tokens).toBe(Math.ceil(user!.chars / 4));
    const groups = groupContextItems(items);
    expect(groups[0].tokens).toBeGreaterThanOrEqual(groups[1].tokens);
    expect(groups.find((g) => g.kind === 'system')?.count).toBe(3);
  });

  it('cuts a long text at four thousand characters and says so', () => {
    const [item] = buildContextItems([{ role: 'user', content: 'x'.repeat(5000) }], [], []);
    expect(item.text).toHaveLength(4000);
    expect(item.truncated).toBe(true);
    expect(item.tokens).toBe(1250);
  });
});
