/**
 * The syntax colours of the file editor (doc/docs/design-system.md "File editor"): a tokenizer small enough to read in one sitting and to test, with no dependency. It
 * works one line at a time, because the two languages the editor shows (JSON and the Markdown of a `SKILL.md`) have no token that spans lines apart from a fenced block, which the
 * Markdown pass tracks itself. A token has the text it covers and a kind that is a CSS class of `.pk-editor` (`k` property name, `s` string, `n` number, `l` true, false and null,
 * `p` punctuation, `h` heading, `c` code, `m` marker); anything the language does not know is `x` (plain), so a text with an error in it still shows every character.
 */

export type TokenKind = 'k' | 's' | 'n' | 'l' | 'p' | 'h' | 'c' | 'm' | 'x';
export interface Token {
  text: string;
  kind: TokenKind;
}
export type CodeLanguage = 'json' | 'yaml' | 'markdown' | 'text';

const push = (tokens: Token[], text: string, kind: TokenKind): void => {
  if (text === '') return;
  const last = tokens.at(-1);
  if (last && last.kind === kind && (kind === 'x' || kind === 'p')) last.text += text;
  else tokens.push({ text, kind });
};

/** One line of JSON. A string is a key when a colon follows it; a string that is not closed runs to the end of the line. */
export function tokenizeJsonLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, line.length);
      const text = line.slice(i, end);
      const closed = j < line.length;
      push(tokens, text, closed && /^\s*:/.test(line.slice(end)) ? 'k' : 's');
      i = end;
    } else if (/[{}[\],:]/.test(c)) {
      push(tokens, c, 'p');
      i++;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(i));
      if (match) {
        push(tokens, match[0], 'n');
        i += match[0].length;
      } else {
        push(tokens, c, 'x');
        i++;
      }
    } else if (/[a-z]/.test(c)) {
      const word = /^[a-z]+/.exec(line.slice(i)) as RegExpExecArray;
      push(tokens, word[0], word[0] === 'true' || word[0] === 'false' || word[0] === 'null' ? 'l' : 'x');
      i += word[0].length;
    } else {
      let j = i;
      while (j < line.length && !/["{}[\],:\-0-9a-z]/.test(line[j])) j++;
      push(tokens, line.slice(i, Math.max(j, i + 1)), 'x');
      i = Math.max(j, i + 1);
    }
  }
  return tokens;
}

/** Inline code (`like this`) inside a line of prose. */
function inlineCode(text: string, tokens: Token[]): void {
  let rest = text;
  while (rest) {
    const match = /`[^`]*`/.exec(rest);
    if (!match) return void push(tokens, rest, 'x');
    push(tokens, rest.slice(0, match.index), 'x');
    push(tokens, match[0], 'c');
    rest = rest.slice(match.index + match[0].length);
  }
}

/** The lines of a Markdown file with frontmatter: the frontmatter's keys and values, headings, list markers, fenced blocks and inline code. */
export function tokenizeMarkdown(lines: readonly string[]): Token[][] {
  let state: 'start' | 'front' | 'body' = 'start';
  let fenced = false;
  return lines.map((line, index) => {
    const tokens: Token[] = [];
    if (state === 'start') state = index === 0 && /^---\s*$/.test(line) ? 'front' : 'body';
    else if (state === 'front' && /^---\s*$/.test(line)) {
      state = 'body';
      push(tokens, line, 'p');
      return tokens;
    }
    if (index === 0 && state === 'front') {
      push(tokens, line, 'p');
      return tokens;
    }
    if (state === 'front') {
      const match = /^(\s*[A-Za-z0-9_.-]+)(:)(.*)$/.exec(line);
      if (match) {
        push(tokens, match[1], 'k');
        push(tokens, match[2], 'p');
        push(tokens, match[3], match[3].trim() ? 's' : 'x');
      } else push(tokens, line, 'x');
      return tokens;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      push(tokens, line, 'c');
      return tokens;
    }
    if (fenced) {
      push(tokens, line, 'c');
      return tokens;
    }
    const heading = /^(#{1,6}\s)(.*)$/.exec(line);
    if (heading) {
      push(tokens, heading[1], 'm');
      push(tokens, heading[2], 'h');
      return tokens;
    }
    const list = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(line);
    if (list) {
      push(tokens, list[1], 'm');
      inlineCode(list[2], tokens);
      return tokens;
    }
    inlineCode(line, tokens);
    return tokens;
  });
}

/** YAML keys, strings, comments and scalars; every character is kept, including invalid input. */
export function tokenizeYamlLine(line: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|([A-Za-z_][\w .-]*)(?=:\s|:$)|([{}[\],:])|\b(true|false|null|~)\b|\b(\d+(?:\.\d+)?)\b/g;
  let at = 0;
  for (const match of line.matchAll(pattern)) {
    push(tokens, line.slice(at, match.index), 'x');
    push(
      tokens,
      match[0],
      match[1]
        ? 'c'
        : match[2]
          ? /^\s*:/.test(line.slice(match.index + match[0].length))
            ? 'k'
            : 's'
          : match[3]
            ? 'k'
            : match[4]
              ? 'p'
              : match[5]
                ? 'l'
                : 'n',
    );
    at = match.index + match[0].length;
  }
  push(tokens, line.slice(at), 'x');
  return tokens;
}

/** The tokens of a text, line by line (the line break is not a token: the editor draws each line as a block). */
export function tokenize(text: string, language: CodeLanguage): Token[][] {
  const lines = text.split('\n');
  if (language === 'yaml') return lines.map(tokenizeYamlLine);
  if (language === 'json') return lines.map(tokenizeJsonLine);
  if (language === 'markdown') return tokenizeMarkdown(lines);
  return lines.map((line) => (line === '' ? [] : [{ text: line, kind: 'x' as const }]));
}
