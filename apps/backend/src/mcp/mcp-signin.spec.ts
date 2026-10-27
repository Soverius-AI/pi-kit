import { describe, expect, it } from 'vitest';
import { signInOutcome } from './mcp.service';

const say = (text: string, level = 'info') => ({ text, level });

/**
 * What a `/mcp login` ended as, read from pi's own notifications (the sign-in state machine): the wording is pi 1.2's (`loginCommand` in its MCP extension), so a
 * newer pi that words it otherwise degrades to "did not happen" and never to a false success.
 */
describe('how a sign-in ended', () => {
  const waiting = say('Sign in to MCP server "linear" in your browser:\nhttps://auth.example/authorize?x=1');

  it('success leaves nothing for the card to show', () => {
    expect(signInOutcome([waiting, say('Signed in to MCP server "linear" (12 tools).')])).toBe('done');
    expect(signInOutcome([say('Signed in to MCP server "linear" (0 tools).')])).toBe('done');
  });

  it('the person gave up', () => {
    expect(signInOutcome([waiting, say('Sign-in cancelled.')])).toEqual({ phase: 'cancelled', message: 'Sign-in cancelled.' });
  });

  it('a refusal at the authorization page is pi’s own error text, as the card shows it', () => {
    expect(signInOutcome([waiting, say('The user denied the request', 'error')])).toEqual({ phase: 'failed', message: 'The user denied the request' });
    expect(signInOutcome([say('Sign-in to MCP server "x" failed: The authorization server does not support dynamic client registration', 'error')])).toMatchObject({ phase: 'failed' });
  });

  it('a command that threw is a failure with its message', () => {
    expect(signInOutcome([waiting], 'boom')).toEqual({ phase: 'failed', message: 'boom' });
  });

  it('a command that ended without an answer (the session reloaded under it) did not sign anyone in', () => {
    expect(signInOutcome([waiting])).toEqual({ phase: 'cancelled' });
    expect(signInOutcome([])).toEqual({ phase: 'cancelled' });
  });
});
