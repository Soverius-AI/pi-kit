import { describe, expect, it } from 'vitest';
import { tokenize, tokenizeJsonLine, tokenizeMarkdown } from './code-tokens';

const joined = (lines: ReturnType<typeof tokenize>): string =>
  lines.map((line) => line.map((t) => t.text).join('')).join('\n');
const kinds = (line: string) => tokenizeJsonLine(line).map((t) => [t.kind, t.text]);

describe('tokenizeJsonLine', () => {
  it('colours keys, strings, numbers, literals and punctuation', () => {
    expect(kinds('  "url": "https://x/mcp",')).toEqual([
      ['x', '  '],
      ['k', '"url"'],
      ['p', ':'],
      ['x', ' '],
      ['s', '"https://x/mcp"'],
      ['p', ','],
    ]);
    expect(kinds('"timeout": -1.5e3, "on": true, "off": false, "none": null')).toEqual([
      ['k', '"timeout"'],
      ['p', ':'],
      ['x', ' '],
      ['n', '-1.5e3'],
      ['p', ','],
      ['x', ' '],
      ['k', '"on"'],
      ['p', ':'],
      ['x', ' '],
      ['l', 'true'],
      ['p', ','],
      ['x', ' '],
      ['k', '"off"'],
      ['p', ':'],
      ['x', ' '],
      ['l', 'false'],
      ['p', ','],
      ['x', ' '],
      ['k', '"none"'],
      ['p', ':'],
      ['x', ' '],
      ['l', 'null'],
    ]);
  });
  it('a string is a key only when a colon follows it', () => {
    expect(kinds('["a", "b"]').map(([k]) => k)).toEqual(['p', 's', 'p', 'x', 's', 'p']);
    expect(kinds('"a" : 1')[0]).toEqual(['k', '"a"']);
  });
  it('an escaped quote stays inside its string, and an unclosed string runs to the end of the line', () => {
    expect(kinds('"say \\"hi\\"": 1')[0]).toEqual(['k', '"say \\"hi\\""']);
    expect(kinds('"open: 1')).toEqual([['s', '"open: 1']]);
  });
  it('keeps every character of a line with an error in it', () => {
    for (const line of ['{ "a": tru, ]', "'single': 1", '"a": 1 2 3', '@@@', '', '"exposure": "codemod",'])
      expect(
        tokenizeJsonLine(line)
          .map((t) => t.text)
          .join(''),
        line,
      ).toBe(line);
    expect(kinds('"a": tru').at(-1)).toEqual(['x', ' tru']);
  });
});

describe('tokenizeMarkdown', () => {
  const text = [
    '---',
    'name: add-a-migration',
    'description: "Use when: a migration is added"',
    '---',
    '',
    '# Add a migration',
    '',
    '## Steps',
    '1. Run `pnpm test`',
    '- plain item',
    '```',
    '# not a heading',
    '```',
    'Use `code` here',
  ];
  const lines = tokenizeMarkdown(text);
  it('colours frontmatter keys and values', () => {
    expect(lines[1].map((t) => [t.kind, t.text])).toEqual([
      ['k', 'name'],
      ['p', ':'],
      ['s', ' add-a-migration'],
    ]);
    expect(lines[0][0].kind).toBe('p');
    expect(lines[3][0].kind).toBe('p');
  });
  it('headings, list markers, fenced blocks and inline code', () => {
    expect(lines[5].map((t) => t.kind)).toEqual(['m', 'h']);
    expect(lines[8].map((t) => [t.kind, t.text])).toEqual([
      ['m', '1. '],
      ['x', 'Run '],
      ['c', '`pnpm test`'],
    ]);
    expect(lines[10][0].kind).toBe('c');
    expect(lines[11][0].kind).toBe('c');
    expect(lines[13].map((t) => t.kind)).toEqual(['x', 'c', 'x']);
  });
  it('does not take a later --- for frontmatter', () => {
    const body = tokenizeMarkdown(['# Title', '---', 'key: value']);
    expect(body[2][0].kind).toBe('x');
  });
  it('keeps every character', () => {
    expect(joined(lines)).toBe(text.join('\n'));
  });
});

describe('tokenize', () => {
  it('one array of tokens per line, for each language', () => {
    expect(tokenize('{\n  "a": 1\n}', 'json')).toHaveLength(3);
    expect(tokenize('a\n\nb', 'text')).toEqual([[{ text: 'a', kind: 'x' }], [], [{ text: 'b', kind: 'x' }]]);
    expect(tokenize('', 'json')).toEqual([[]]);
  });
});

describe('YAML syntax colors', () => {
  it('keeps strings, URLs, shell expressions and incomplete YAML intact', () => {
    const text =
      '# comment\nmodels:\n  qwen:\n    cmd: "llama-server --port ${PORT} # part of string"\n    proxy: http://127.0.0.1:8080\n    ttl: 120 # timeout\n    broken: [unterminated';
    const lines = tokenize(text, 'yaml');
    expect(joined(lines)).toBe(text);
    expect(lines[0].some((token) => token.kind === 'c')).toBe(true);
    expect(lines[1].some((token) => token.kind === 'k' && token.text === 'models')).toBe(true);
    expect(lines[3].some((token) => token.kind === 's' && token.text.includes('# part of string'))).toBe(true);
  });
});
