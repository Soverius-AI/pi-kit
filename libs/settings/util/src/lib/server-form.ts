import type { Translate } from '@pi-kit/i18n';
import {
  type McpExposure,
  type McpKv,
  type McpScope,
  type McpServerBody,
  type McpServerCreate,
  type McpServerDetail,
  MCP_SERVER_NAME,
  joinArgs,
  looksLikeSecret,
  previewEntry,
  splitArgs,
} from '@pi-kit/protocol';
import { validUrl } from './add-server';

/**
 * The details form of an MCP server as pure functions: the state of the form, what it sends, what it checks, and "As it will be written". The form is shared by the
 * "Add a server" wizard (a server of your own) and the edit dialog. A header or environment value that is a secret (the person marked it, the name says so, or it has the shape of a key)
 * is never in this state: the component keeps the typed text outside its signals and passes it to {@link bodyOfForm} for the one request that sends it.
 */

/** One header or environment variable. `value` is the text of a plain value; a secret row has none here (`filled` says whether text was typed). */
export interface KvRow {
  /** Stable while the row is on the page, so the component can keep a typed secret by it. */
  uid: number;
  key: string;
  value: string;
  /** The person marked the value as a secret with the lock. */
  marked: boolean;
  /** The value is a secret (marked, or it looks like one): kept in the credential store. */
  secret: boolean;
  /** A secret was typed in the field. */
  filled: boolean;
  /** The file already has this value in the credential store; the form never sees it. Typing replaces it. */
  stored: boolean;
  /** The text the field starts with. It is set when the row is made and never changes: the field owns what is typed, so a value that turns into a secret is not wiped from under the person's cursor. */
  shown: string;
}

export interface ServerForm {
  name: string;
  kind: 'url' | 'command';
  url: string;
  command: string;
  /** The arguments on one line; quotes keep an argument together. */
  args: string;
  headers: KvRow[];
  env: KvRow[];
  exposure: McpExposure;
  description: string;
  scope: McpScope;
  enabled: boolean;
}

let uids = 0;
export const nextUid = (): number => ++uids;

export const blankRow = (): KvRow => ({
  uid: nextUid(),
  key: '',
  value: '',
  marked: false,
  secret: false,
  filled: false,
  stored: false,
  shown: '',
});

export function blankForm(scope: McpScope = 'user'): ServerForm {
  return {
    name: '',
    kind: 'url',
    url: '',
    command: '',
    args: '',
    headers: [],
    env: [],
    exposure: 'codemode',
    description: '',
    scope,
    enabled: true,
  };
}

/**
 * The form of a server in a file, and the typed text of the rows that hold a secret. A value the file has in the credential store has no text (the row says `stored`). A literal in the
 * file that looks like a secret (a token somebody pasted into `mcp.json`) is shown as a secret too: a password field, never the text, and saving moves it into the credential store.
 */
export function loadForm(detail: McpServerDetail): { form: ServerForm; secrets: Map<number, string> } {
  const secrets = new Map<number, string>();
  const rows = (items: McpServerDetail['headers']): KvRow[] =>
    items.map((item) => {
      const uid = nextUid();
      const text = item.value ?? '';
      if (!item.stored && text !== '' && looksLikeSecret(item.key, text)) {
        secrets.set(uid, text);
        return { uid, key: item.key, value: '', marked: false, secret: true, filled: true, stored: false, shown: text };
      }
      return {
        uid,
        key: item.key,
        value: text,
        marked: false,
        secret: !!item.stored,
        filled: false,
        stored: !!item.stored,
        shown: text,
      };
    });
  const form: ServerForm = {
    name: detail.name,
    kind: detail.kind,
    url: detail.url,
    command: detail.command,
    args: joinArgs(detail.args),
    headers: rows(detail.headers),
    env: rows(detail.env),
    exposure: detail.exposure,
    description: detail.description,
    scope: detail.scope,
    enabled: detail.enabled,
  };
  return { form, secrets };
}

/** The form alone (the text of a literal secret is in {@link loadForm}'s map). */
export const formOfDetail = (detail: McpServerDetail): ServerForm => loadForm(detail).form;

/**
 * A row after its value changed to `text`: a secret row keeps no text (the caller keeps it), a plain row does. `secret` is decided by the lock, a stored value being replaced, the key's
 * name and the shape of the text.
 */
export function withValue(row: KvRow, text: string): { row: KvRow; secretText: string | undefined } {
  const secret = row.marked || row.stored || looksLikeSecret(row.key, text);
  return secret
    ? { row: { ...row, value: '', secret: true, filled: text !== '' }, secretText: text }
    : { row: { ...row, value: text, secret: false, filled: false }, secretText: undefined };
}

/** A row after its key changed: a name like `Authorization` makes an existing value a secret, so the text moves out of the state (returned for the caller to keep). */
export function withKey(row: KvRow, key: string): { row: KvRow; moved: string | undefined } {
  const next = { ...row, key };
  if (!row.secret && !row.marked && row.value && looksLikeSecret(key, row.value))
    return { row: { ...next, value: '', secret: true, filled: true }, moved: row.value };
  return { row: next, moved: undefined };
}

/** The lock: marks a value as a secret (or takes the mark off). A plain value moves out of the state when it is marked; the text of a secret row comes back when it is unmarked. */
export function withMark(
  row: KvRow,
  marked: boolean,
  kept: string | undefined,
): { row: KvRow; moved: string | undefined; restored: string | undefined } {
  if (marked)
    return {
      row: { ...row, marked: true, secret: true, filled: row.value !== '' || row.filled, value: '' },
      moved: row.value || undefined,
      restored: undefined,
    };
  const text = kept ?? '';
  const secret = row.stored || looksLikeSecret(row.key, text);
  if (secret) return { row: { ...row, marked: false, secret: true }, moved: undefined, restored: undefined };
  return {
    row: { ...row, marked: false, secret: false, value: text, filled: false },
    moved: undefined,
    restored: text,
  };
}

const rowsOf = (rows: readonly KvRow[], secrets: ReadonlyMap<number, string>): McpKv[] => {
  const out: McpKv[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.secret) {
      const typed = secrets.get(row.uid);
      if (typed) out.push({ key, value: typed, secret: true });
      else if (row.stored) out.push({ key });
      else if (row.marked) continue;
    } else if (row.value !== '') out.push({ key, value: row.value });
  }
  return out;
};

/** The body of `PATCH /api/mcp/servers/:name` for the form. `secrets` holds the typed text of the secret rows by `uid`. */
export function bodyOfForm(form: ServerForm, secrets: ReadonlyMap<number, string> = new Map()): McpServerBody {
  const base = {
    name: form.name.trim(),
    kind: form.kind,
    exposure: form.exposure,
    description: form.description.trim(),
    enabled: form.enabled,
  } as const;
  return form.kind === 'url'
    ? { ...base, url: form.url.trim(), headers: rowsOf(form.headers, secrets) }
    : { ...base, command: form.command.trim(), args: splitArgs(form.args), env: rowsOf(form.env, secrets) };
}

export const createOfForm = (form: ServerForm, secrets: ReadonlyMap<number, string> = new Map()): McpServerCreate => ({
  ...bodyOfForm(form, secrets),
  scope: form.scope,
});

export interface FormProblem {
  field: 'name' | 'url' | 'command' | 'headers' | 'env';
  message: string;
}

/** What is wrong with the form so far, or nothing. */
export function validateForm(translate: Translate, form: ServerForm): FormProblem | undefined {
  if (!MCP_SERVER_NAME.test(form.name.trim()))
    return { field: 'name', message: translate('settings.serverForm.giveItANameOfLettersDigits') };
  if (form.kind === 'url') {
    if (!validUrl(form.url.trim()))
      return { field: 'url', message: translate('settings.serverForm.aRemoteServerSURLStartsWith') };
  } else if (!form.command.trim())
    return { field: 'command', message: translate('settings.serverForm.typeTheCommandThatStartsTheServer') };
  for (const [field, rows] of [
    ['headers', form.headers],
    ['env', form.env],
  ] as const) {
    const keys = rows.map((r) => r.key.trim()).filter(Boolean);
    const dup = keys.find(
      (key, i) =>
        keys.findIndex((k) => (field === 'headers' ? k.toLowerCase() === key.toLowerCase() : k === key)) !== i,
    );
    if (dup) return { field, message: translate('settings.serverForm.isThereTwice', { value1: dup }) };
    if (field === 'env' && keys.some((k) => /[=\s]/.test(k)))
      return { field, message: translate('settings.serverForm.aVariableNameHasNoSpacesOr') };
  }
  return undefined;
}

/** The `Authorization` token the reachability check may use: the value of that header, without its `Bearer ` (the check sends it as a bearer token). */
export function checkToken(form: ServerForm, secrets: ReadonlyMap<number, string>): string | undefined {
  const row = form.headers.find((r) => r.key.trim().toLowerCase() === 'authorization');
  if (!row) return undefined;
  const text = (row.secret ? secrets.get(row.uid) : row.value)?.trim();
  if (!text || /^!|\$\{?[A-Za-z_]/.test(text)) return undefined;
  return text.replace(/^Bearer\s+/i, '') || undefined;
}

/** "As it will be written": the entry, as the file gets it, without the braces of the file around it. A secret shows as the command that prints it. */
export function previewText(form: ServerForm, secrets: ReadonlyMap<number, string> = new Map()): string {
  const body = bodyOfForm(form, secrets);
  // A row whose secret is stored has no value in the body; the file keeps its command, which the preview names.
  const existing: Record<string, unknown> = {};
  for (const [kind, rows] of [
    ['headers', form.headers],
    ['env', form.env],
  ] as const) {
    const kept = rows.filter((r) => r.stored && r.key.trim() && !secrets.get(r.uid));
    if (kept.length > 0)
      existing[kind] = Object.fromEntries(
        kept.map((r) => [r.key.trim(), '!(the command that prints the value you stored)']),
      );
  }
  const entry = previewEntry({ ...body, name: body.name || 'name' }, existing);
  const json = JSON.stringify({ [body.name || 'name']: entry }, null, 2).split('\n');
  return json
    .slice(1, -1)
    .map((line) => line.slice(2))
    .join('\n');
}

/** Where the typed secrets of a row go, in words, for the hint under the rows. */
export function secretHint(translate: Translate, store: { available: boolean; label: string } | undefined): string {
  return store?.available
    ? translate('settings.serverForm.aSecretValueATokenAKey', { value1: store.label })
    : translate('settings.serverForm.thereIsNoCredentialStoreOnThis');
}
