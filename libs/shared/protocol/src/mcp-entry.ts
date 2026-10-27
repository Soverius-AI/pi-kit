import { z } from 'zod';
import { type McpExposure, McpExposureSchema } from './mcp';
import { redactText } from './redact';
import { isProviderAccount, parseResolver } from './secrets';

/**
 * The details form of an MCP server and the `mcp.json` entry it stands, as pure functions so the renderer's "As it will be written" and the backend's
 * write are the same code, and the round trip form -> entry -> form is a unit test. pi owns the format (docs/mcp.md): `url` + `headers`, or `command` + `args` + `env`, plus
 * `description`, `exposure` and `enabled`. A header or env value is a literal, a `${VAR}` reference, or a `!command` that makes up the whole value; a value that looks like a secret is
 * kept in the credential store and the file gets the command that prints it, never the value.
 */

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** A header or an environment variable of the form. `value` left out keeps what the file has for that key (a stored secret is never sent back to the form). */
export const McpKvSchema = z
  .object({
    key: z.string().min(1).max(200),
    value: z.string().max(16_384).meta({ secret: true }).optional(),
    /** The person marked the value as a secret (or the form saw that it looks like one): it goes to the credential store. */
    secret: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'McpKv' });
export type McpKv = z.infer<typeof McpKvSchema>;

export const McpScopeSchema = z.enum(['user', 'project']);
export type McpScope = z.infer<typeof McpScopeSchema>;

/** `?scope=&thread=` of the routes of one server: which file (the project's when the thread's folder is), and the session that reloads. */
export const McpServerQuerySchema = z.object({ scope: McpScopeSchema.optional(), thread: z.string().optional() });
export type McpServerQuery = z.infer<typeof McpServerQuerySchema>;

const specShape = {
  name: z.string().min(1).max(64).regex(MCP_SERVER_NAME, 'letters, digits, "-" and "_"'),
  kind: z.enum(['url', 'command']),
  url: z.string().max(2048).optional(),
  command: z.string().max(1024).optional(),
  args: z.array(z.string().max(2048)).max(200).optional(),
  headers: z.array(McpKvSchema).max(50).optional(),
  env: z.array(McpKvSchema).max(100).optional(),
  exposure: McpExposureSchema,
  description: z.string().max(500).optional(),
  enabled: z.boolean(),
};

const needsTarget = (value: { kind: 'url' | 'command'; url?: string | undefined; command?: string | undefined }): boolean =>
  value.kind === 'url' ? !!value.url?.trim() : !!value.command?.trim();

/** What the form sends to change a server (`PATCH /api/mcp/servers/:name?scope=`); a different `name` renames it. */
export const McpServerBodySchema = z.object(specShape).strict().refine(needsTarget, 'a server needs a URL or a command').meta({ id: 'McpServerBody' });
export type McpServerBody = z.infer<typeof McpServerBodySchema>;

/** `POST /api/mcp/servers`: the same, and the file it goes to. A `project` entry needs a thread in a trusted folder (`?thread=`). */
export const McpServerCreateSchema = z
  .object({ ...specShape, scope: McpScopeSchema })
  .strict()
  .refine(needsTarget, 'a server needs a URL or a command')
  .meta({ id: 'McpServerCreate' });
export type McpServerCreate = z.infer<typeof McpServerCreateSchema>;

/** One row of the answer for the form: a stored secret has no `value`, only `stored`. */
export const McpKvDetailSchema = z.object({ key: z.string(), value: z.string().optional(), stored: z.boolean().optional() }).meta({ id: 'McpKvDetail' });
export type McpKvDetail = z.infer<typeof McpKvDetailSchema>;

/** The form of a server that is in a file, prefilled (`GET /api/mcp/servers/:name`). Keys the form does not know (`oauth`, `timeout`, `cwd`, `toolExposure`) stay in the file and are listed in `kept`. */
export const McpServerDetailSchema = z
  .object({
    name: z.string(),
    scope: McpScopeSchema,
    /** The file the entry is in. */
    path: z.string(),
    kind: z.enum(['url', 'command']),
    url: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    headers: z.array(McpKvDetailSchema),
    env: z.array(McpKvDetailSchema),
    exposure: McpExposureSchema,
    description: z.string(),
    enabled: z.boolean(),
    /** Other keys of the entry that a save leaves as they are. */
    kept: z.array(z.string()),
    /** The server signs in with OAuth (a URL without an `Authorization` header). */
    oauth: z.boolean(),
  })
  .meta({ id: 'McpServerDetail' });
export type McpServerDetail = z.infer<typeof McpServerDetailSchema>;

// ---- what looks like a secret

const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'authorization', 'bearer', 'apikey', 'cookie', 'passphrase']);
const SECRET_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['auth', 'token'],
  ['client', 'secret'],
];

/** The lowercase words of a header or variable name: `X-Api-Key`, `GITHUB_TOKEN` and `apiKey` all split at their word edges. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether the value is made only of references (`${TOKEN}`, `$TOKEN`) or is a command: nothing literal in it to keep safe. */
export function isReference(value: string): boolean {
  if (value.startsWith('!')) return true;
  return /\$\{?[A-Za-z_]\w*\}?/.test(value) && !/[A-Za-z0-9]{20,}/.test(value.replace(/\$\{?[A-Za-z_]\w*\}?/g, ''));
}

/** A value already stored by pi-kit: the command that prints it from the credential store. */
export const isStoredSecret = (value: string): boolean => parseResolver(value) !== undefined || /^!echo Bearer \$\((?:security|secret-tool) /.test(value) || /^!pi-kit-secret get \S+ --bearer$/.test(value);

/**
 * Whether a header or environment value should go to the credential store: the name says it carries a credential (`Authorization`, `X-Api-Key`, `GITHUB_TOKEN`, `DB_PASSWORD`) or the value
 * has a known key shape (`ghp_…`, `sk-…`, a `Bearer` token). A reference or a command is never a secret to keep; an empty value has nothing to keep.
 */
export function looksLikeSecret(key: string, value: string): boolean {
  const v = value.trim();
  if (!v || isReference(v)) return false;
  const words = wordsOf(key);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  if (SECRET_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b))) return true;
  return redactText(v).count > 0;
}

// ---- the entry

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The keys the form owns; any other key of an entry is kept as it is. */
const MANAGED = ['url', 'headers', 'command', 'args', 'env', 'description', 'exposure', 'enabled', 'type'] as const;
const CANONICAL = ['url', 'headers', 'command', 'args', 'env', 'description', 'exposure', 'enabled'] as const;

/** Where the credential of a header or variable is kept: `mcp-<server>-header-<name>`; the characters a keychain account and a shell word can carry. */
export function secretAccount(server: string, kind: 'header' | 'env', key: string): string {
  const clean = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const account = `mcp-${clean(server)}-${kind}-${clean(key)}`.slice(0, 64).replace(/[-.]+$/, '');
  return isProviderAccount(account) ? account : `mcp-${kind}-${Math.abs(hash(`${server}\0${key}`)).toString(36)}`;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

/** What the writer needs from the credential store: keep a value under an account and say what the file gets. `undefined` = no store, the value goes in as it is. */
export type KeepSecret = (account: string, value: string) => string | undefined;

export interface BuiltEntry {
  entry: Raw;
  /** Header and variable keys whose value went to the credential store (account names, for the caller to remember and to remove with the server). */
  stored: string[];
  /** Keys that would have gone to the store but could not (no store): the caller says so. */
  plain: string[];
}

function rows(rowsIn: readonly McpKv[] | undefined, existing: unknown, kind: 'header' | 'env', server: string, keep: KeepSecret): { out: Record<string, string>; stored: string[]; plain: string[] } {
  const kept = isRecord(existing) ? existing : {};
  const out: Record<string, string> = {};
  const stored: string[] = [];
  const plain: string[] = [];
  for (const row of rowsIn ?? []) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.value === undefined) {
      // Not sent: whatever the file has stays (a stored secret, or a value the form did not show).
      if (typeof kept[key] === 'string') out[key] = kept[key];
      continue;
    }
    const value = row.value;
    if (value === '' && !row.secret) continue;
    const wanted = row.secret === true || looksLikeSecret(key, value);
    if (wanted && value !== '' && !isStoredSecret(value)) {
      const account = secretAccount(server, kind, key);
      const command = keep(account, value);
      if (command === undefined) {
        out[key] = value;
        plain.push(key);
      } else {
        out[key] = command;
        stored.push(account);
      }
    } else {
      out[key] = value;
    }
  }
  return { out, stored, plain };
}

/**
 * The `mcp.json` entry the form describes. `existing` is the entry as it is in the file (for a change): keys the form does not own are kept, a row without a value keeps the file's value,
 * and the keys keep their order. `keep` is the credential store: a value that looks like a secret (or is marked as one) goes through it and the entry gets the command that prints it.
 */
export function buildServerEntry(form: McpServerBody, existing: Raw | undefined, keep: KeepSecret): BuiltEntry {
  const managed: Raw = {};
  const stored: string[] = [];
  const plain: string[] = [];
  if (form.kind === 'url') {
    managed['url'] = (form.url ?? '').trim();
    const headers = rows(form.headers, existing?.['headers'], 'header', form.name, keep);
    if (Object.keys(headers.out).length > 0) managed['headers'] = headers.out;
    stored.push(...headers.stored);
    plain.push(...headers.plain);
  } else {
    managed['command'] = (form.command ?? '').trim();
    const args = (form.args ?? []).filter((a) => a !== '');
    if (args.length > 0) managed['args'] = args;
    const env = rows(form.env, existing?.['env'], 'env', form.name, keep);
    if (Object.keys(env.out).length > 0) managed['env'] = env.out;
    stored.push(...env.stored);
    plain.push(...env.plain);
  }
  const description = (form.description ?? '').trim();
  if (description) managed['description'] = description;
  // pi keeps its defaults out of the file: `codemode` and `enabled: true` are not written (as its own `/mcp` manager does).
  if (form.exposure !== 'codemode') managed['exposure'] = form.exposure;
  if (!form.enabled) managed['enabled'] = false;
  // `type` is only kept when it still says what the entry is.
  const type = existing?.['type'];
  if (typeof type === 'string' && (form.kind === 'url' ? type !== 'stdio' : type === 'stdio')) managed['type'] = type;

  const entry: Raw = {};
  if (existing) {
    for (const key of Object.keys(existing)) {
      if ((MANAGED as readonly string[]).includes(key)) {
        if (key in managed) entry[key] = managed[key];
      } else entry[key] = existing[key];
    }
  }
  for (const key of CANONICAL) if (key in managed && !(key in entry)) entry[key] = managed[key];
  if ('type' in managed && !('type' in entry)) entry['type'] = managed['type'];
  return { entry, stored, plain };
}

/** The line break between a command and its arguments, so the form can show arguments on one line and quotes keep one together. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Arguments back to one line: an argument with a space or a quote is quoted, so `splitArgs(joinArgs(a))` is `a`. */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? (a.includes('"') && !a.includes("'") ? `'${a}'` : `"${a}"`) : a)).join(' ');
}

/** An entry of a file as the form shows it. Stored secrets (our own resolver commands) carry no value; `stored: true` says one is there. */
export function serverDetailOf(name: string, scope: McpScope, path: string, raw: Raw): McpServerDetail {
  const url = typeof raw['url'] === 'string' ? raw['url'] : '';
  const kvs = (value: unknown): McpKvDetail[] =>
    isRecord(value)
      ? Object.entries(value)
          .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
          .map(([key, v]) => (isStoredSecret(v) ? { key, stored: true } : { key, value: v }))
      : [];
  const kept = Object.keys(raw).filter((key) => !(MANAGED as readonly string[]).includes(key));
  const headers = isRecord(raw['headers']) ? Object.keys(raw['headers']) : [];
  const exposure = McpExposureSchema.safeParse(raw['exposure'] === 'codemode-deferred' ? 'codemode' : raw['exposure']);
  return {
    name,
    scope,
    path,
    kind: url || typeof raw['command'] !== 'string' ? 'url' : 'command',
    url,
    command: typeof raw['command'] === 'string' ? raw['command'] : '',
    args: Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : [],
    headers: kvs(raw['headers']),
    env: kvs(raw['env']),
    exposure: exposure.success ? exposure.data : 'codemode',
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    enabled: raw['enabled'] !== false,
    kept,
    oauth: !!url && !headers.some((h) => h.toLowerCase() === 'authorization') && raw['auth'] === undefined,
  };
}

/** The credential-store accounts an entry's headers and variables read their values from, when pi-kit put them there (`mcp-…`): what goes with the server when it is removed or no longer used. */
export function storedAccountsOf(entry: Raw): string[] {
  const accounts = new Set<string>();
  for (const key of ['headers', 'env']) {
    const rowsOf = entry[key];
    if (!isRecord(rowsOf)) continue;
    for (const value of Object.values(rowsOf)) {
      const account = typeof value === 'string' ? parseResolver(value)?.provider : undefined;
      if (account?.startsWith('mcp-')) accounts.add(account);
    }
  }
  return [...accounts];
}

/** The form a detail fills: rows that hold a stored secret send no value (the file keeps it). */
export function bodyOfDetail(detail: McpServerDetail): McpServerBody {
  const kv = (rows: readonly McpKvDetail[]): McpKv[] => rows.map((r) => (r.stored ? { key: r.key } : { key: r.key, value: r.value ?? '' }));
  return {
    name: detail.name,
    kind: detail.kind,
    ...(detail.kind === 'url' ? { url: detail.url, headers: kv(detail.headers) } : { command: detail.command, args: detail.args, env: kv(detail.env) }),
    exposure: detail.exposure,
    description: detail.description,
    enabled: detail.enabled,
  };
}

/**
 * "As it will be written": the entry as the file gets it, for the live preview. A value that will go to the credential store shows as the command that prints it (`!pi-kit-secret get <account>`
 * stands for the platform's own command) and never as the value; rows that keep the file's value show what the file has.
 */
export function previewEntry(form: McpServerBody, existing: Raw | undefined): Raw {
  const entry = buildServerEntry(form, existing, (account) => `!pi-kit-secret get ${account}`).entry;
  // `existing` here is only the rows whose value the file keeps, so its key order says nothing: the preview is in pi's usual order.
  const ordered: Raw = {};
  for (const key of [...CANONICAL, 'type']) if (key in entry) ordered[key] = entry[key];
  for (const key of Object.keys(entry)) if (!(key in ordered)) ordered[key] = entry[key];
  return ordered;
}

export type { McpExposure };
