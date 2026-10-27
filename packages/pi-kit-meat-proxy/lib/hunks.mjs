// The outcome diff split into hunks. Plain ESM, no dependencies. A hunk's id is `<path>@<oldStart>:<newStart>`, the two start lines of its `@@` header exactly as git
// prints them: pi-kit's diff viewer derives the same id from its diff model, so a label stored for a hunk finds the hunk on screen (doc/docs/plugins.md, "Hunk ids").

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The id of a hunk: its file and the starting lines of its two sides. */
export const hunkId = (file, oldStart, newStart) => `${file}@${oldStart}:${newStart}`;

/** Git quotes a path with special characters (`"a/\303\244.txt"`): the text without the quotes, the escapes resolved. */
function unquote(text) {
  const bytes = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const n = body[i + 1];
    if (/[0-7]/.test(n ?? '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92 }[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path a `diff --git a/x b/x` line names (renames are off in the outcome diff, so both sides are the same path). */
function fileOf(line) {
  const plain = /^diff --git a\/(.+) b\/\1$/.exec(line);
  if (plain) return plain[1];
  const quoted = /^diff --git ("a\/(?:[^"\\]|\\.)*") ("b\/(?:[^"\\]|\\.)*")$/.exec(line);
  if (quoted) return unquote(quoted[2]).slice(2);
  const loose = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return loose ? loose[1] : undefined;
}

/**
 * The hunks of a unified diff (`git diff base..head`, `-U3 --no-renames`), in order. Each is `{ id, file, header, section, oldStart, oldLines, newStart, newLines, added, removed, lines }`;
 * `lines` are the body lines with their sign. The header's counts say where a hunk ends, so a removed line that reads `-- x` is not mistaken for a file header. Binary files and mode
 * changes have no hunks. A diff that was cut in the middle of a hunk yields that hunk with the lines it has.
 */
export function splitDiff(diff) {
  const hunks = [];
  if (!diff) return hunks;
  let file;
  let current;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(diff).replace(/\r\n/g, '\n').split('\n')) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      const sign = line[0];
      if (sign === '+') {
        newLeft -= 1;
        current.added += 1;
        current.lines.push(line);
        continue;
      }
      if (sign === '-') {
        oldLeft -= 1;
        current.removed += 1;
        current.lines.push(line);
        continue;
      }
      if (sign === ' ' || line === '') {
        oldLeft -= 1;
        newLeft -= 1;
        current.lines.push(line === '' ? ' ' : line);
        continue;
      }
      if (sign === '\\') continue;
    } else if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('diff --git ')) {
      file = fileOf(line);
      current = undefined;
      continue;
    }
    const header = HEADER.exec(line);
    if (header && file !== undefined) {
      const oldStart = Number(header[1]);
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      current = { id: hunkId(file, oldStart, newStart), file, header: `@@ -${header[1]}${header[2] === undefined ? '' : `,${header[2]}`} +${header[3]}${header[4] === undefined ? '' : `,${header[4]}`} @@`, section: header[5].trim(), oldStart, oldLines, newStart, newLines, added: 0, removed: 0, lines: [] };
      oldLeft = oldLines;
      newLeft = newLines;
      hunks.push(current);
    }
  }
  return hunks;
}

/** What a hunk weighs in a score: the lines it adds and removes. */
export const weightOf = (hunk) => hunk.added + hunk.removed;

/** The first changed lines of a hunk, for a prompt or an example (signs kept, each cut to `width`). */
export function excerptOf(hunk, count = 3, width = 120) {
  return hunk.lines
    .filter((l) => l[0] === '+' || l[0] === '-')
    .slice(0, count)
    .map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}
