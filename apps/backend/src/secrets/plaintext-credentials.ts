import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isProviderAccount, parseResolver, type MoveKeysResult } from '@pi-kit/protocol';
import type { SecretStore } from '@pi-kit/secret-store';

/** Only recognize commands pi-kit generated. Never execute arbitrary shell commands. */
function reference(value: string): { account: string; bearer: boolean } | undefined {
  const direct = parseResolver(value);
  if (direct) return { account: direct.provider, bearer: false };
  const helper = /^!pi-kit-secret get ([A-Za-z0-9._-]+) --bearer$/.exec(value);
  if (helper) return { account: helper[1], bearer: true };
  const wrapped = /^!echo Bearer \$\((.+)\)$/.exec(value);
  const parsed = wrapped && parseResolver(`!${wrapped[1]}`);
  return parsed ? { account: parsed.provider, bearer: true } : undefined;
}

/** Export user-level references only. Keep store entries (including the database key) and unreadable references intact. */
export async function plaintextCredentialFile(path: string, store: SecretStore, auth = false): Promise<MoveKeysResult> {
  const result: MoveKeysResult = { moved: [], failed: [] };
  if (!existsSync(path)) return result;
  if (!lstatSync(path).isFile()) throw new Error('Credential migration requires a regular file.');
  const original = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(original);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid credential configuration.');
  const convert = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') {
      const ref = reference(value);
      if (!ref || !isProviderAccount(ref.account)) return value;
      try {
        const secret = await store.get(ref.account);
        if (secret === undefined || secret === '') throw new Error('missing');
        result.moved.push(ref.account);
        return ref.bearer ? `Bearer ${secret}` : secret;
      } catch {
        // Native errors may include sensitive data. Return account names and a fixed explanation only.
        result.failed.push({ provider: ref.account, reason: 'Could not read the saved credential. Re-enter it to stop using its existing resolver.' });
        return value;
      }
    }
    if (Array.isArray(value)) return Promise.all(value.map(convert));
    if (value && typeof value === 'object') {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value)) entries.push([key, await convert(item)]);
      return Object.fromEntries(entries);
    }
    return value;
  };
  let next: unknown;
  if (auth) {
    // OAuth tokens, custom commands and environment references are not API-key exports.
    next = Object.fromEntries(await Promise.all(Object.entries(parsed).map(async ([id, entry]) => {
      if (!entry || typeof entry !== 'object' || (entry as { type?: string }).type !== 'api_key') return [id, entry];
      const credential = entry as { key?: unknown };
      return [id, { ...entry, key: await convert(credential.key) }];
    })));
  } else next = await convert(parsed);
  if (!result.moved.length) return result;
  const temporary = `${path}.plaintext-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (readFileSync(path, 'utf8') !== original) throw new Error('Configuration changed during migration. Retry after saving it.');
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return result;
}
