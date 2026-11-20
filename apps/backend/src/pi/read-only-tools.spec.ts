import { describe, expect, it } from 'vitest';
import { ReadOnlyTools } from './read-only-tools';

describe('ReadOnlyTools', () => {
  it('lets the readers through', () => {
    for (const tool of ['read', 'ls', 'find', 'grep']) expect(ReadOnlyTools.block(tool, {})).toBeUndefined();
  });

  it('allows shell commands that only read, without redirection or a second command', () => {
    expect(ReadOnlyTools.block('bash', { command: 'git diff HEAD~1' })).toBeUndefined();
    expect(ReadOnlyTools.block('bash', { command: 'pnpm test' })).toBeUndefined();
    expect(ReadOnlyTools.block('bash', { command: 'rm -rf src' })).toContain('read-only');
    expect(ReadOnlyTools.block('bash', { command: 'cat a > b' })).toContain('read-only');
    expect(ReadOnlyTools.block('bash', { command: 'ls; rm a' })).toContain('read-only');
    expect(ReadOnlyTools.block('bash', { command: 'echo $(rm a)' })).toContain('read-only');
  });

  it('refuses writing tools, questions nobody can answer and starting other agents', () => {
    for (const tool of ['write', 'edit', 'ask_user', 'agent_spawn', 'browser_navigate', 'mcp'])
      expect(ReadOnlyTools.block(tool, {})).toContain(`${tool} is not available`);
  });
});
