import { z } from 'zod';
import { MCP_EXPOSURES, McpOverviewSchema } from './mcp';
import { MCP_SERVER_NAME } from './mcp-entry';

/**
 * Checking an `mcp.json` before it is saved ("Edit here"): the text is parsed with positions (so an error can name its line, and the editor can mark it in the
 * gutter), then validated against one zod shape: the one `mcp-config.ts` reads and docs/mcp.md describes. It is as strict as pi is and no stricter: unknown keys stay (pi ignores them),
 * and only what pi would reject is an error. Pure, so the editor (renderer) and `PUT /api/mcp/file` (backend) are the same check.
 */

export interface JsonPosition {
  /** 1-based. */
  line: number;
  column: number;
}

/** A parsed node's place: where its key is (when it is a property) and where its value starts. */
interface Located {
  key?: number;
  value: number;
}

export interface ParsedJson {
  value: unknown;
  /** Offsets of the properties and elements by path, for the position of an error. */
  at(path: readonly (string | number)[]): number | undefined;
}

export interface JsonSyntaxError {
  message: string;
  offset: number;
}

class Stop extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
  }
}

/** `line` and `column` (both 1-based) of an offset in a text. */
export function positionOf(text: string, offset: number): JsonPosition {
  let line = 1;
  let last = -1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: end - last };
}

/**
 * A JSON parser that keeps where every property and element starts. It accepts exactly JSON (no comments, no trailing commas: pi's `JSON.parse` would reject them too) and stops at the
 * first error with a message that says what was expected, which is more than `JSON.parse` says and has the offset the editor marks.
 */
export function parseJson(text: string): { ok: true; parsed: ParsedJson } | { ok: false; error: JsonSyntaxError } {
  const places = new Map<string, Located>();
  let i = 0;
  const pathKey = (path: readonly (string | number)[]): string => JSON.stringify(path);
  const ws = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const describe = (): string => (i >= text.length ? 'the end of the file' : `"${text[i] === '\n' ? '\\n' : text[i]}"`);
  const string = (): string => {
    const start = i;
    i++;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\n') throw new Stop(start, 'This string is not closed on its line.');
      if (c === '\\') {
        const next = text[i + 1];
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Stop(i, 'A \\u escape needs four hex digits.');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (next === undefined || !(next in map)) throw new Stop(i, `"\\${next ?? ''}" is not a JSON escape.`);
        out += map[next];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    throw new Stop(start, 'This string is not closed.');
  };
  const value = (path: (string | number)[]): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Stop(i, `Expected a property name in quotes, found ${describe()}.`);
        const keyAt = i;
        const key = string();
        ws();
        if (text[i] !== ':') throw new Stop(i, `Expected ":" after "${key}", found ${describe()}.`);
        i++;
        ws();
        const child = [...path, key];
        places.set(pathKey(child), { key: keyAt, value: i });
        obj[key] = value(child);
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === '}') throw new Stop(i, 'A trailing comma: JSON has no comma after the last property.');
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        throw new Stop(i, `Expected "," or "}", found ${describe()}.`);
      }
    }
    if (c === '[') {
      i++;
      const list: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return list;
      }
      for (;;) {
        ws();
        const child = [...path, list.length];
        places.set(pathKey(child), { value: i });
        list.push(value(child));
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === ']') throw new Stop(i, 'A trailing comma: JSON has no comma after the last item.');
          continue;
        }
        if (text[i] === ']') {
          i++;
          return list;
        }
        throw new Stop(i, `Expected "," or "]", found ${describe()}.`);
      }
    }
    if (c === '"') return string();
    const literal = /^(?:true|false|null)/.exec(text.slice(i, i + 5));
    if (literal) {
      i += literal[0].length;
      return literal[0] === 'true' ? true : literal[0] === 'false' ? false : null;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) {
      i += number[0].length;
      return Number(number[0]);
    }
    throw new Stop(i, c === undefined ? 'The file ends where a value is expected.' : `Expected a value, found ${describe()}.`);
  };
  try {
    const root = value([]);
    ws();
    if (i < text.length) throw new Stop(i, `Unexpected ${describe()} after the end of the JSON.`);
    return {
      ok: true,
      parsed: {
        value: root,
        at: (path) => {
          const found = places.get(pathKey(path));
          if (path.length === 0) return 0;
          return found ? (typeof path[path.length - 1] === 'string' ? (found.key ?? found.value) : found.value) : undefined;
        },
      },
    };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, error: { message: error.message, offset: error.offset } };
    throw error;
  }
}

// ---- the shape

const exposureError = `must be one of ${MCP_EXPOSURES.join(', ')}.`;
const Exposure = z.union([z.enum(MCP_EXPOSURES), z.literal('codemode-deferred')], { error: () => exposureError });
const Strings = z.record(z.string(), z.string({ error: 'must be text.' }), { error: 'must be an object of text values.' });

/** One entry of `mcpServers`. An entry with neither `command`, `url` nor `type` is a project override of `enabled` / `exposure` (checked per file, below). */
export const McpEntryFileSchema = z.looseObject(
  {
  type: z.enum(['stdio', 'http', 'streamable-http'], { error: (issue) => (issue.input === 'sse' ? 'the legacy SSE transport is not supported; use the streamable HTTP address (often /mcp).' : 'must be stdio, http or streamable-http.') }).optional(),
  command: z.string({ error: 'must be text.' }).min(1, 'must not be empty.').optional(),
  args: z.array(z.string({ error: 'must be text.' }), { error: 'must be a list of text.' }).optional(),
  env: Strings.optional(),
  cwd: z.string({ error: 'must be text.' }).optional(),
  url: z.string({ error: 'must be text.' }).min(1, 'must not be empty.').optional(),
  headers: Strings.optional(),
  oauth: z.looseObject({}, { error: 'must be an object.' }).optional(),
  timeout: z.number({ error: 'must be a number of seconds.' }).positive('must be more than zero.').optional(),
  enabled: z.boolean({ error: 'must be true or false.' }).optional(),
  exposure: Exposure.optional(),
  toolExposure: z.record(z.string(), Exposure, { error: 'must be an object of exposures.' }).optional(),
  description: z.string({ error: 'must be text.' }).optional(),
  },
  { error: 'must be an object.' },
);

/** The whole file. */
export const McpFileShapeSchema = z.looseObject({
  mcpServers: z.record(z.string(), McpEntryFileSchema, { error: 'must be an object of servers.' }).optional(),
  autoEnableCodemode: z.boolean({ error: 'must be true or false.' }).optional(),
});

export interface McpFileProblem {
  line: number;
  column: number;
  message: string;
}

export interface McpFileCheck {
  ok: boolean;
  problems: McpFileProblem[];
}

const label = (path: readonly PropertyKey[]): string => path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[');

/**
 * Checks the text of an `mcp.json`: JSON first (one problem at most: the parser stops), then the shape. `scope` decides whether an entry without `command` or `url` is an error (the
 * user file) or a project override (allowed in the project file). Problems come in file order; the first is the one the editor shows.
 */
export function checkMcpFile(text: string, scope: 'user' | 'project'): McpFileCheck {
  if (text.trim() === '') return { ok: true, problems: [] };
  const syntax = parseJson(text);
  if (!syntax.ok) return { ok: false, problems: [{ ...positionOf(text, syntax.error.offset), message: syntax.error.message }] };
  const { parsed } = syntax;
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, problems: [{ ...positionOf(text, parsed.at([]) ?? 0), message: 'The file must be a JSON object with an "mcpServers" object in it.' }] };
  }
  const problems: McpFileProblem[] = [];
  const add = (path: readonly (string | number)[], message: string): void => {
    // The nearest ancestor that has a place (a missing key is reported on its parent).
    let at: number | undefined;
    for (let n = path.length; n >= 0 && at === undefined; n--) at = parsed.at(path.slice(0, n));
    problems.push({ ...positionOf(text, at ?? 0), message });
  };
  const result = McpFileShapeSchema.safeParse(parsed.value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.filter((p): p is string | number => typeof p !== 'symbol');
      const where = label(path);
      add(path, path.length === 0 ? issue.message : issue.code === 'invalid_key' ? issue.message : `${where.split('.').pop()} ${issue.message}`.replace(/\s+/g, ' ').replace(/ \./g, '.'));
    }
  }
  // What a schema of fields cannot say: an entry needs to run something.
  const servers = (parsed.value as { mcpServers?: unknown }).mcpServers;
  if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
    for (const [name, raw] of Object.entries(servers)) {
      if (!MCP_SERVER_NAME.test(name)) add(['mcpServers', name], `Server name "${name}" may contain only letters, digits, "_" and "-".`);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const hasTarget = typeof entry['command'] === 'string' || typeof entry['url'] === 'string';
      const override = entry['command'] === undefined && entry['url'] === undefined && entry['type'] === undefined;
      if (!hasTarget && !(scope === 'project' && override)) add(['mcpServers', name], `Server "${name}" needs a "command" or a "url".`);
      if (typeof entry['command'] === 'string' && typeof entry['url'] === 'string') add(['mcpServers', name, 'url'], `Server "${name}" has both "command" and "url"; use one.`);
    }
  }
  problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return { ok: problems.length === 0, problems };
}

/** "Line 13: exposure must be one of …" for the line under the editor. */
export const describeProblem = (problem: McpFileProblem): string => `Line ${problem.line}: ${problem.message}`;

/** The servers an `mcp.json` text defines (for the count in "The files"); 0 for text that does not parse. */
export function countServers(text: string): number {
  const parsed = parseJson(text);
  if (!parsed.ok) return 0;
  const servers = (parsed.parsed.value as { mcpServers?: unknown } | null)?.mcpServers;
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers) ? Object.keys(servers).length : 0;
}

// ---- the REST shapes of GET / PUT /api/mcp/file

export const McpFileSchema = z
  .object({
    scope: z.enum(['user', 'project']),
    path: z.string(),
    /** The file's text; empty for a file that is not there yet. */
    text: z.string(),
    /** Modified time in ms (0 when the file does not exist), to notice a change made in between. */
    mtime: z.number(),
    exists: z.boolean(),
  })
  .meta({ id: 'McpFile' });
export type McpFile = z.infer<typeof McpFileSchema>;

export const McpFilePutSchema = z
  .object({
    text: z.string().max(1_000_000),
    /** The `mtime` the editor loaded; the save is refused (409) when the file changed since. */
    mtime: z.number(),
  })
  .strict()
  .meta({ id: 'McpFilePut' });
export type McpFilePut = z.infer<typeof McpFilePutSchema>;

/** `?scope=&thread=`: which file; the project's belongs to the folder of the thread. */
export const McpFileScopeQuerySchema = z.object({ scope: z.enum(['user', 'project']), thread: z.string().optional() });
export type McpFileScopeQuery = z.infer<typeof McpFileScopeQuerySchema>;

/** What a save of the file answers: the file as it is now and the servers after pi read it again. */
export const McpFileSavedSchema = z.object({ file: McpFileSchema, message: z.string().optional(), overview: McpOverviewSchema }).meta({ id: 'McpFileSaved' });
export type McpFileSaved = z.infer<typeof McpFileSavedSchema>;
