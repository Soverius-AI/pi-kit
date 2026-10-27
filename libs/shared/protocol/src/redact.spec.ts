import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION, RedactionConfigSchema, compileUserPatterns, redact, redactJsonl, redactText, redactValue } from './redact';

/** Made-up secrets of each provider's shape. None of them is a real credential; each is assembled from halves so that secret scanners
 * (GitHub push protection among them) do not take the fixtures for leaked tokens. */
const fake = (...parts: string[]): string => parts.join('');
const FIXTURES: { kind: string; secret: string; line: (s: string) => string }[] = [
  { kind: 'openrouter key', secret: fake('sk-or-v1-0123456789abcdef0123456789a', 'bcdef0123456789abcdef0123456789a1b2'), line: (s) => `export OPENROUTER_API_KEY=${s}` },
  { kind: 'anthropic key', secret: fake('sk-ant-api03-AbCdEfGhIjKlMnOpQrS', 'tUvWxYz0123456789_-AbCdEfGh-a1b2'), line: (s) => `ANTHROPIC_API_KEY="${s}"` },
  { kind: 'openai key', secret: fake('sk-proj-AbCdEfGhIjKlMnOpQrStU', 'vWxYz0123456789AbCdEfGh-a1b2'), line: (s) => `curl -H "Authorization: Bearer ${s}"` },
  { kind: 'openai key', secret: fake('sk-AbCdEfGhIjKlMnOpQrS', 'tUvWxYz0123456789a1b2'), line: (s) => `my key is ${s}, please use it` },
  { kind: 'github token', secret: fake('ghp_AbCdEfGhIjKlMnOp', 'QrStUvWxYz0123456789'), line: (s) => `git clone https://${s}@github.com/acme/app.git` },
  { kind: 'github token', secret: fake('github_pat_11ABCDEFG0AbCdEfGhIjKl_AbCdEfGhI', 'jKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp'), line: (s) => `token: ${s}` },
  { kind: 'aws access key', secret: fake('AKIAIOSFOD', 'NN7EXAMPLE'), line: (s) => `aws_access_key_id = ${s}` },
  { kind: 'aws secret key', secret: fake('wJalrXUtnFEMI/K7MDEN', 'G/bPxRfiCYEXAMPLEKEY'), line: (s) => `aws_secret_access_key = ${s}` },
  { kind: 'slack token', secret: fake('xox', 'b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'), line: (s) => `SLACK_BOT_TOKEN=${s}` },
  { kind: 'google api key', secret: fake('AIzaSyA-1234567890ab', 'cdefghijklmnopqrstu'), line: (s) => `key=${s}` },
  { kind: 'bearer token', secret: fake('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM', '0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123'), line: (s) => `Authorization: ${s}` },
];

describe('redaction of key shapes', () => {
  for (const { kind, secret, line } of FIXTURES) {
    it(`masks ${kind} (${secret.slice(0, 8)}…) and keeps the text around it`, () => {
      const input = line(secret);
      const { text, count, kinds } = redactText(input);
      expect(text).not.toContain(secret.slice(4, -4));
      expect(text).toMatch(new RegExp(`\\[redacted ${kind} …${secret.slice(-4).replace(/[/+]/g, '\\$&')}\\]`));
      expect(count).toBe(1);
      expect(kinds).toEqual([kind]);
      // What was around the secret is still there.
      expect(text.length).toBeGreaterThan(10);
      expect(text.startsWith(input.slice(0, 4))).toBe(true);
    });
  }

  it('masks a private key block whole, with no tail', () => {
    const block = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACD0Zm9vYmFyYmF6\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(`before\n${block}\nafter`)).toBe('before\n[redacted private key block]\nafter');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow cut off in a paste')).toBe('[redacted private key block]');
  });

  it('tells the specific shapes apart from the general sk- shape', () => {
    const text = 'a sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789zzzz b sk-ant-api03-0123456789abcdef0123456789abcdefzzzz c sk-0123456789abcdef0123456789abcdefzzzz';
    expect(redactText(text).kinds).toEqual(['openrouter key', 'anthropic key', 'openai key']);
  });

  it('masks every occurrence and each shows its own last four, so two keys can be told apart', () => {
    const out = redact('one sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aaaa and two sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789bbbb');
    expect(out).toBe('one [redacted openai key …aaaa] and two [redacted openai key …bbbb]');
  });

  it('leaves ordinary text, short strings and the masks themselves alone', () => {
    for (const text of ['The sk- prefix is used by OpenAI.', 'skeleton-key-0123456789', 'const x = "Bearer"', 'git commit -m "fix: handle 401"', 'ab', '[redacted openai key …a1b2] stays']) {
      expect(redactText(text)).toMatchObject({ text, count: 0 });
    }
  });

  it('is idempotent: masking masked text changes nothing', () => {
    const once = redact('token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 and Bearer abcdefghijklmnopqrstuvwxyz012345');
    expect(redact(once)).toBe(once);
  });

  it('does not take a long hexadecimal commit id or a UUID for a key', () => {
    for (const text of ['commit 9fceb02d0ae598e95dc970b74767f19372d61af6', 'id 3f9a1c21-6a7e-4a52-8f0e-1f3ae5d9c21e', 'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']) {
      expect(redactText(text).count).toBe(0);
    }
  });
});

describe('user patterns', () => {
  it('apply after the built-in ones and use the pattern’s name as the kind', () => {
    const { compiled, errors } = compileUserPatterns([{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }]);
    expect(errors).toEqual([]);
    expect(redact('use acme_abcdef123456 now', compiled)).toBe('use [redacted acme token …3456] now');
  });

  it('drop a pattern that is not a regular expression or matches nothing in particular, and say which', () => {
    const { compiled, errors } = compileUserPatterns([
      { name: 'broken', regex: '(' },
      { name: 'everything', regex: '.*' },
      { name: 'fine', regex: 'zz-[0-9]{6}' },
    ]);
    expect(compiled.map((p) => p.kind)).toEqual(['fine']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^broken:/);
    expect(errors[1]).toMatch(/^everything:.*empty/);
  });

  it('have a default that does nothing, and a schema that fills the gaps', () => {
    expect(DEFAULT_REDACTION).toEqual({ patterns: [], offFor: [] });
    expect(RedactionConfigSchema.parse({})).toEqual({ patterns: [], offFor: [] });
  });
});

describe('structured data', () => {
  it('redacts every string in a JSON value and leaves ids, types and numbers', () => {
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const event = { type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 't1', content: `remote: ${secret}`, nested: [{ text: `x ${secret}` }, 42, null] };
    const out = redactValue(event);
    expect(out).toEqual({ type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 't1', content: 'remote: [redacted github token …6789]', nested: [{ text: 'x [redacted github token …6789]' }, 42, null] });
    expect(event.content).toContain(secret);
  });

  it('redacts a JSON Lines session file line by line, keeps the other lines byte for byte, and counts what it changed', () => {
    const secret = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789a1b2';
    const clean = JSON.stringify({ type: 'session', id: 'abc', version: 3 });
    const dirty = JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `my key is ${secret}` }] } });
    const { text, count } = redactJsonl(`${clean}\n${dirty}\nnot json but ${secret}\n`);
    const lines = text.split('\n');
    expect(lines[0]).toBe(clean);
    expect(JSON.parse(lines[1]).message.content[0].text).toBe('my key is [redacted openai key …a1b2]');
    expect(lines[2]).toBe('not json but [redacted openai key …a1b2]');
    expect(lines[3]).toBe('');
    expect(count).toBe(2);
    expect(text).not.toContain(secret);
  });
});
