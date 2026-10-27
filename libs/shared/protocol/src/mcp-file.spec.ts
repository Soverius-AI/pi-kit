import { describe, expect, it } from 'vitest';
import { checkMcpFile, countServers, describeProblem, parseJson, positionOf } from './mcp-file';

const GOOD = `{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "exposure": "deferred"
    },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"], "env": { "A": "1" } },
    "slack": { "url": "https://mcp.slack.com/mcp", "enabled": false }
  },
  "autoEnableCodemode": false
}
`;

describe('parseJson', () => {
  it('parses what JSON.parse parses', () => {
    const parsed = parseJson(GOOD);
    expect(parsed.ok && parsed.parsed.value).toEqual(JSON.parse(GOOD));
  });
  it('knows where a property and an element are', () => {
    const parsed = parseJson(GOOD);
    if (!parsed.ok) throw new Error('did not parse');
    expect(positionOf(GOOD, parsed.parsed.at(['mcpServers', 'linear', 'exposure']) ?? -1)).toEqual({ line: 5, column: 7 });
    expect(positionOf(GOOD, parsed.parsed.at(['mcpServers', 'playwright', 'args', 0]) ?? -1).line).toBe(7);
  });
  it('says what it expected, with the place', () => {
    const missingComma = '{\n  "a": 1\n  "b": 2\n}';
    const result = parseJson(missingComma);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Expected "," or "}"/);
      expect(positionOf(missingComma, result.error.offset).line).toBe(3);
    }
    expect(parseJson('{"a": 1,}')).toMatchObject({ ok: false, error: { message: expect.stringMatching(/trailing comma/) } });
    expect(parseJson('{"a": "x')).toMatchObject({ ok: false });
    expect(parseJson('{"a": tru}')).toMatchObject({ ok: false });
    expect(parseJson('{} extra')).toMatchObject({ ok: false });
    expect(parseJson('')).toMatchObject({ ok: false });
  });
});

describe('checkMcpFile', () => {
  it('accepts a good file, an empty file, and unknown keys', () => {
    expect(checkMcpFile(GOOD, 'user')).toEqual({ ok: true, problems: [] });
    expect(checkMcpFile('', 'user').ok).toBe(true);
    expect(checkMcpFile('{}', 'user').ok).toBe(true);
    expect(checkMcpFile('{"mcpServers":{"a":{"url":"https://x/mcp","somethingNew":1}},"other":true}', 'user').ok).toBe(true);
  });

  it('puts a bad exposure on its line, like the mockup', () => {
    const text = GOOD.replace('"deferred"', '"codemod"');
    const check = checkMcpFile(text, 'user');
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatchObject({ line: 5 });
    expect(describeProblem(check.problems[0])).toBe('Line 5: exposure must be one of codemode, deferred, direct, hidden.');
  });

  it('reports a syntax error on its line, and only that one', () => {
    const check = checkMcpFile(GOOD.replace('"exposure": "deferred"', '"exposure": "deferred",'), 'user');
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0].line).toBe(6);
    expect(check.problems[0].message).toMatch(/trailing comma/);
  });

  it('wants the file to be an object, mcpServers an object, and an entry to run something', () => {
    expect(checkMcpFile('[]', 'user').problems[0].message).toMatch(/JSON object/);
    expect(checkMcpFile('{"mcpServers": []}', 'user').problems[0].message).toMatch(/mcpServers must be an object/);
    const noTarget = checkMcpFile('{\n"mcpServers": {\n"a": { "description": "x" }\n}\n}', 'user');
    expect(noTarget.problems[0]).toMatchObject({ line: 3, message: 'Server "a" needs a "command" or a "url".' });
    expect(checkMcpFile('{"mcpServers":{"a":{"command":"x","url":"https://x/mcp"}}}', 'user').problems[0].message).toMatch(/both/);
    expect(checkMcpFile('{"mcpServers":{"a":5}}', 'user').problems[0].message).toMatch(/must be an object/);
  });

  it('allows a project override without command or url, and not a user entry', () => {
    const override = '{"mcpServers":{"linear":{"enabled":false}}}';
    expect(checkMcpFile(override, 'project').ok).toBe(true);
    expect(checkMcpFile(override, 'user').ok).toBe(false);
  });

  it('checks names, types of fields and the SSE transport', () => {
    expect(checkMcpFile('{"mcpServers":{"bad name":{"url":"https://x/mcp"}}}', 'user').problems[0].message).toMatch(/letters, digits/);
    expect(checkMcpFile('{"mcpServers":{"a":{"command":"x","args":"nope"}}}', 'user').problems[0].message).toMatch(/args must be a list/);
    expect(checkMcpFile('{"mcpServers":{"a":{"command":"x","env":{"A":1}}}}', 'user').problems[0].message).toMatch(/must be text/);
    expect(checkMcpFile('{"mcpServers":{"a":{"url":"https://x/mcp","type":"sse"}}}', 'user').problems[0].message).toMatch(/SSE/);
    expect(checkMcpFile('{"mcpServers":{"a":{"url":"https://x/mcp","enabled":"no"}}}', 'user').problems[0].message).toMatch(/true or false/);
    expect(checkMcpFile('{"mcpServers":{"a":{"url":"https://x/mcp","exposure":"codemode-deferred","toolExposure":{"get_*":"direct"}}}}', 'user').ok).toBe(true);
  });

  it('lists the problems in file order', () => {
    const check = checkMcpFile('{\n"mcpServers": {\n"a": { "url": "https://x/mcp", "enabled": 1 },\n"b": { "command": "" }\n}\n}', 'user');
    expect(check.problems.map((p) => p.line)).toEqual([3, 4]);
  });
});

describe('countServers', () => {
  it('counts the entries, and zero for text that does not parse', () => {
    expect(countServers(GOOD)).toBe(3);
    expect(countServers('{')).toBe(0);
    expect(countServers('{}')).toBe(0);
  });
});
