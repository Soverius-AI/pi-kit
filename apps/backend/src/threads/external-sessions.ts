import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ExternalSessionSource } from '@pi-kit/protocol';
import type { ImportedMessage } from '../pi/session-files';

export type { ImportedMessage };

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ExternalSnapshot {
  key: string;
  source: ExternalSessionSource;
  nativeId: string;
  title: string;
  updatedAt: number;
  fingerprint: string;
  messages: ImportedMessage[];
  file?: { path: string; stamp: string };
}
export interface ExternalDiscovery {
  sessions: ExternalSnapshot[];
  unavailable: ExternalSessionSource[];
  skipped: number;
}

/** Keep tool context useful without copying binaries or unbounded outputs into the next model request. */
function toolText(text: string): string {
  const limit = 8_000;
  return text.length <= limit
    ? text
    : `${text.slice(0, limit / 2)}\n[… ${text.length - limit} characters omitted]\n${text.slice(-limit / 2)}`;
}

function mergeMessages(messages: ImportedMessage[]): ImportedMessage[] {
  const merged: ImportedMessage[] = [];
  for (const message of messages) {
    if (!message.text.trim()) continue;
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.text += `\n\n${message.text}`;
      previous.timestamp = Math.max(previous.timestamp, message.timestamp);
    } else merged.push({ ...message });
  }
  return merged;
}

/** Only displayable history crosses runtimes. Tools stay inert text; signed reasoning and runtime configuration are omitted. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return array(content)
    .map((value) => {
      const block = record(value);
      if (['text', 'input_text', 'output_text', 'inputText'].includes(string(block['type'])))
        return string(block['text']);
      if (block['type'] === 'tool_use')
        return `[Historical tool call: ${string(block['name'])}]\n${toolText(JSON.stringify(block['input'] ?? {}))}`;
      if (block['type'] === 'tool_result')
        return `[Historical tool result]\n${toolText(contentText(block['content']))}`;
      if (['thinking', 'redacted_thinking'].includes(string(block['type']))) return '';
      return `[${string(block['type']) || 'Attachment'}: available in the original session]`;
    })
    .filter(Boolean)
    .join('\n');
}

export async function canonicalCwd(cwd: string): Promise<string> {
  const path = await realpath(cwd).catch(() => resolve(cwd));
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Retain only normalized text while streaming; raw image/tool payloads are released after each record. */
function claudeHistory(nativeId: string) {
  const nodes = new Map<string, { parent: string; messages: ImportedMessage[]; summary: boolean }>();
  let leaf = '';
  let name = '';
  let malformed = false;
  return {
    line(line: string): void {
      if (!line.trim()) return;
      if (malformed) throw new Error('Malformed record inside a Claude session.');
      let row: RecordValue;
      try {
        row = record(JSON.parse(line));
      } catch {
        malformed = true;
        return;
      }
      if (row['isSidechain'] === true) return;
      if (row['type'] === 'custom-title') name = string(row['customTitle']);
      const id = string(row['uuid']);
      if (!id) return;
      const messages: ImportedMessage[] = [];
      if (row['type'] === 'user' || row['type'] === 'assistant') {
        leaf = id;
        if (!row['isMeta'] && !row['isApiErrorMessage']) {
          const content = record(row['message'])['content'];
          for (const block of typeof content === 'string' ? [content] : array(content)) {
            const text = contentText(typeof block === 'string' ? block : [block]);
            const role = row['type'] === 'assistant' || record(block)['type'] === 'tool_result' ? 'assistant' : 'user';
            if (text) messages.push({ role, text, timestamp: Date.parse(string(row['timestamp'])) || 0 });
          }
        }
      }
      // A compaction boundary has no parent; its logical parent is the history it replaced.
      const parent = string(row['parentUuid']) || string(row['logicalParentUuid']);
      nodes.set(id, { parent, messages, summary: row['isCompactSummary'] === true });
    },
    finish(): ExternalSnapshot | undefined {
      const path: { messages: ImportedMessage[]; summary: boolean }[] = [];
      const seen = new Set<string>();
      for (let id = leaf; id && !seen.has(id);) {
        seen.add(id);
        const node = nodes.get(id);
        if (!node) break;
        path.push(node);
        id = node.parent;
      }
      const history: ImportedMessage[] = [];
      for (const node of path.reverse()) {
        // The summary repeats the history before it; it stands in only when that history is not in this file.
        if (!node.summary || !history.length) history.push(...node.messages);
      }
      const messages = mergeMessages(history);
      if (!messages.length) return undefined;
      const title =
        name ||
        messages
          .find((message) => message.role === 'user')
          ?.text.split('\n')[0]
          .slice(0, 160) ||
        'Claude Code';
      return {
        key: fingerprint(['claude-code', nativeId]),
        source: 'claude-code',
        nativeId,
        title,
        updatedAt: messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0),
        fingerprint: fingerprint({ title, messages }),
        messages,
      };
    },
  };
}

/** Parse the active branch. Identity comes from the filename, while project membership is checked separately. */
export function readClaudeSnapshot(text: string, nativeId: string): ExternalSnapshot | undefined {
  const history = claudeHistory(nativeId);
  for (const line of text.split('\n')) history.line(line);
  return history.finish();
}

export class CodexReadError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Codex 0.165.0 rejects a method it does not know while parsing the request (-32600), not with -32601. */
const unknownMethod = (error: CodexReadError): boolean =>
  error.code === -32601 || (error.code === -32600 && /unknown variant/i.test(error.message));

/** A short-lived read-only app-server client. No thread/resume or turn/start requests are made. */
export async function withCodex<T>(
  use: (call: (method: string, params: RecordValue) => Promise<RecordValue>) => Promise<T>,
): Promise<T> {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  const pending = new Map<
    number,
    { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let sequence = 0;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex session reader exited.')));
  child.stdin.on('error', fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = record(JSON.parse(line));
      if (typeof message['id'] !== 'number') return;
      const request = pending.get(message['id']);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message['id']);
      if (message['error']) {
        const error = record(message['error']);
        request.reject(
          new CodexReadError(
            string(error['message']) || 'Codex read failed.',
            typeof error['code'] === 'number' ? error['code'] : undefined,
          ),
        );
      } else request.resolve(record(message['result']));
    } catch {
      fail(new Error('Invalid response from the Codex session reader.'));
    }
  });
  const call = (method: string, params: RecordValue): Promise<RecordValue> => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Codex session reader timed out.'));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  try {
    await call('initialize', { clientInfo: { name: 'pi-kit-import', version: '1.0.0' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return await use(call);
  } finally {
    lines.close();
    fail(new Error('Codex session reader closed.'));
    child.stdin.end();
    child.kill();
  }
}

export function codexMessages(entries: unknown[]): ImportedMessage[] {
  return mergeMessages(
    entries
      .flatMap<ImportedMessage>((entry) => {
        const wrapper = record(entry);
        const item = record(wrapper['item'] ?? entry);
        const type = string(item['type']);
        const timestamp = Number(wrapper['startedAtMs']) || 0;
        if (type === 'userMessage') return [{ role: 'user' as const, text: contentText(item['content']), timestamp }];
        if (type === 'agentMessage') return [{ role: 'assistant' as const, text: string(item['text']), timestamp }];
        if (type === 'plan') return [{ role: 'assistant' as const, text: string(item['text']), timestamp }];
        if (['reasoning', 'hookPrompt', 'contextCompaction'].includes(type)) return [];
        let text = `[Historical ${type}: details remain in the original session]`;
        if (type === 'commandExecution')
          text = `[Historical command]\n${toolText(string(item['command']))}\nExit: ${item['exitCode'] ?? 'unknown'}\n${toolText(string(item['aggregatedOutput']))}`;
        if (type === 'fileChange')
          text = `[Historical file changes]\n${toolText(
            array(item['changes'])
              .map((change) => string(record(change)['path']))
              .join('\n'),
          )}`;
        if (type === 'functionCallOutput')
          text = `[Historical tool result: ${string(item['name'])}]\n${toolText(contentText(item['output']))}`;
        if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
          const output = record(item['result']);
          text = `[Historical tool: ${string(item['server'])} ${string(item['tool'])}]\n${toolText(JSON.stringify(item['arguments'] ?? {}))}\n${toolText(contentText(output['content'] ?? item['contentItems']))}`;
        }
        return [{ role: 'assistant' as const, text, timestamp }];
      })
      .filter((message) => message.text.trim()),
  );
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(dir, entry.name));
}

async function* linesOf(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    yield* lines;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function sourceStamp(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return fingerprint([info.size, info.mtimeMs]);
  } catch {
    return undefined;
  }
}

/** Read only metadata until the project is known; unrelated large transcripts never need a full load. */
async function claudeProject(path: string): Promise<string | undefined> {
  for await (const line of linesOf(path)) {
    if (!line.trim()) continue;
    const row = record(JSON.parse(line));
    if (row['isSidechain'] !== true && typeof row['cwd'] === 'string') return row['cwd'];
  }
  return undefined;
}

/** What a Claude transcript said when it was last read, valid while its size and modification time stand. */
export interface CachedTranscript {
  stamp: string;
  cwd: string | undefined;
  /** Its listing entry, or null without importable history; unset until the whole transcript was read. */
  listed?: ExternalSnapshot | null;
}
export type TranscriptCache = Map<string, CachedTranscript>;

const stampOf = (info: { size: number; mtimeMs: number }): string => `${info.size}:${info.mtimeMs}`;

/** Throws only when `root` cannot be listed. */
async function addClaudeSessions(
  result: ExternalDiscovery,
  root: string,
  canonical: string,
  { key, cache = new Map() }: { key?: string; cache?: TranscriptCache },
): Promise<void> {
  const dirs = await readdir(root, { withFileTypes: true });
  const present = new Set<string>();
  // The transcript's cwd is authoritative; encoded directory names may be hashed or customized.
  for (const dir of dirs.filter((entry) => entry.isDirectory())) {
    let ours = false;
    let unreadable = 0;
    for (const path of await filesIn(join(root, dir.name)).catch(() => [])) {
      present.add(path);
      const nativeId = basename(path, '.jsonl');
      if (key && key !== fingerprint(['claude-code', nativeId])) continue;
      try {
        const stamp = stampOf(await stat(path));
        let known = cache.get(path);
        if (known?.stamp !== stamp) cache.set(path, (known = { stamp, cwd: await claudeProject(path) }));
        if (!known.cwd || (await canonicalCwd(known.cwd)) !== canonical) continue;
        ours = true;
        // An import needs the messages, which the cache does not keep.
        if (!key && known.listed !== undefined) {
          if (known.listed) result.sessions.push(known.listed);
          continue;
        }
        const history = claudeHistory(nativeId);
        for await (const line of linesOf(path)) history.line(line);
        if (stampOf(await stat(path)) !== stamp) {
          result.skipped++;
          continue;
        }
        const snapshot = history.finish();
        const listed = snapshot ? { ...snapshot, messages: [] } : null;
        known.listed = listed;
        if (snapshot && listed) result.sessions.push(key ? snapshot : listed);
      } catch {
        unreadable++;
      }
    }
    // A transcript too broken to name its project counts only next to this project's own transcripts.
    if (ours) result.skipped += unreadable;
  }
  if (!key) for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
}

/** Lists from thread metadata only; `loadCodexSnapshot` reads the history of the one being imported. */
async function addCodexSessions(
  result: ExternalDiscovery,
  reader: typeof withCodex,
  cwd: string,
  canonical: string,
  key?: string,
): Promise<void> {
  await reader(async (call) => {
    let cursor: unknown = undefined;
    do {
      const page = await call('thread/list', {
        cwd: [cwd, canonical],
        modelProviders: [],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const value of array(page['data'])) {
        const thread = record(value);
        if ((await canonicalCwd(string(thread['cwd']))) !== canonical || thread['parentThreadId']) continue;
        const nativeId = string(thread['id']);
        if (!nativeId) continue;
        if (key && fingerprint(['codex', nativeId]) !== key) continue;
        const title = string(thread['name']) || string(thread['preview']).split('\n')[0].slice(0, 160) || 'Codex';
        const updatedAt = Number(thread['updatedAt']) * 1000 || 0;
        const path = string(thread['path']);
        const stamp = path ? await sourceStamp(path) : undefined;
        result.sessions.push({
          key: fingerprint(['codex', nativeId]),
          source: 'codex',
          nativeId,
          title,
          updatedAt,
          fingerprint: fingerprint({ nativeId, title, updatedAt, stamp }),
          messages: [],
          ...(path && stamp ? { file: { path, stamp } } : {}),
        });
      }
      cursor = page['nextCursor'];
    } while (cursor);
  });
}

export async function discoverExternalSessions(
  cwd: string,
  options: {
    claudeRoot?: string;
    codex?: typeof withCodex;
    /** Revalidate one selection during import without loading every other conversation again. */
    key?: string;
    /** Kept between calls, a listing only reads the Claude transcripts that are new or changed. */
    cache?: TranscriptCache;
  } = {},
): Promise<ExternalDiscovery> {
  const result: ExternalDiscovery = { sessions: [], unavailable: [], skipped: 0 };
  const canonical = await canonicalCwd(cwd);
  const claudeRoot =
    options.claudeRoot ?? join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects');
  await addClaudeSessions(result, claudeRoot, canonical, options).catch(() => result.unavailable.push('claude-code'));
  if (!options.key || !result.sessions.length)
    await addCodexSessions(result, options.codex ?? withCodex, cwd, canonical, options.key).catch(() =>
      result.unavailable.push('codex'),
    );
  const unique = new Map<string, ExternalSnapshot>();
  for (const session of result.sessions) {
    if (!unique.has(session.key) || (unique.get(session.key)?.updatedAt ?? 0) < session.updatedAt)
      unique.set(session.key, session);
  }
  result.sessions = [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return result;
}

/** Codex CLI 0.165.0+ read protocol (checked with `codex app-server generate-ts`), with a method-not-found fallback. */
export async function loadCodexSnapshot(
  snapshot: ExternalSnapshot,
  reader: typeof withCodex = withCodex,
): Promise<ExternalSnapshot> {
  return reader(async (call) => {
    if (snapshot.file && (await sourceStamp(snapshot.file.path)) !== snapshot.file.stamp)
      throw new Error('The source session changed. Check again before importing.');
    const before = record((await call('thread/read', { threadId: snapshot.nativeId }))['thread']);
    // thread/list uses database recency; thread/read can use the last rollout event instead.
    // A local file stamp is authoritative when available and also catches changes within one second.
    if (!snapshot.file && Number(before['updatedAt']) * 1000 !== snapshot.updatedAt)
      throw new Error('The source session changed. Check again before importing.');
    const entries: unknown[] = [];
    let cursor: unknown;
    try {
      do {
        const page = await call('thread/items/list', {
          threadId: snapshot.nativeId,
          limit: 100,
          sortDirection: 'asc',
          ...(cursor ? { cursor } : {}),
        });
        entries.push(...array(page['data']));
        cursor = page['nextCursor'];
      } while (cursor);
    } catch (error) {
      if (!(error instanceof CodexReadError) || !unknownMethod(error)) throw error;
      entries.length = 0;
      const full = record((await call('thread/read', { threadId: snapshot.nativeId, includeTurns: true }))['thread']);
      for (const turn of array(full['turns'])) entries.push(...array(record(turn)['items']));
    }
    const after = record((await call('thread/read', { threadId: snapshot.nativeId }))['thread']);
    if (
      before['updatedAt'] !== after['updatedAt'] ||
      (snapshot.file && (await sourceStamp(snapshot.file.path)) !== snapshot.file.stamp)
    )
      throw new Error('The source session changed during import. Check again.');
    const messages = codexMessages(entries);
    const title = string(before['name']) || snapshot.title;
    return { ...snapshot, title, fingerprint: fingerprint({ title, messages }), messages };
  });
}
