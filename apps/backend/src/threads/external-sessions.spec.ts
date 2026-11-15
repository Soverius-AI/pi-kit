import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPi } from '../pi/load-pi';
import { importHistory } from '../pi/session-files';
import {
  codexMessages,
  discoverExternalSessions,
  fingerprint,
  loadCodexSnapshot,
  readClaudeSnapshot,
  type ExternalSnapshot,
  withCodex,
  CodexReadError,
  type TranscriptCache,
} from './external-sessions';

vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const stamp = '2026-11-15T10:00:00Z';
const turn = (cwd: string, uuid: string, parentUuid: string | null, role: string, content: unknown) => ({
  type: role,
  uuid,
  parentUuid,
  sessionId: 'claude-original',
  cwd,
  timestamp: stamp,
  message: { role, content },
});
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external session history', () => {
  it('follows Claude’s latest main branch and keeps tool history inert', () => {
    const snapshot = readClaudeSnapshot(
      jsonl([
        turn('/project', 'u', null, 'user', 'Build it'),
        turn('/project', 'old', 'u', 'assistant', 'An abandoned branch'),
        { ...turn('/project', 'sub', 'u', 'assistant', 'Subagent history'), isSidechain: true },
        turn('/project', 'a', 'u', 'assistant', [
          { type: 'thinking', thinking: 'signed private reasoning', signature: 'do-not-copy' },
          { type: 'text', text: 'Working' },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } },
        ]),
        turn('/project', 'r', 'a', 'user', [{ type: 'tool_result', content: 'hello' }, { type: 'image' }]),
        { type: 'custom-title', customTitle: 'My conversation' },
      ]),
      'file-session-id',
    );
    expect(snapshot?.title).toBe('My conversation');
    expect(snapshot?.messages).toHaveLength(3);
    expect(snapshot?.nativeId).toBe('file-session-id');
    expect(snapshot?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    const text = JSON.stringify(snapshot?.messages);
    expect(text).toContain('Historical tool call: Bash');
    expect(text).toContain('Historical tool result');
    expect(text).toContain('available in the original session');
    expect(text).not.toMatch(/abandoned|Subagent|signed private|do-not-copy/);
  });

  it('keeps the history before a Claude compaction instead of its summary', () => {
    const rows = [
      turn('/project', 'u', null, 'user', 'First request'),
      turn('/project', 'a', 'u', 'assistant', 'First answer'),
      { type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null, logicalParentUuid: 'a' },
      { type: 'attachment', uuid: 'f', parentUuid: 'b' },
      { ...turn('/project', 's', 'f', 'user', 'This session is being continued'), isCompactSummary: true },
      turn('/project', 'n', 's', 'assistant', 'Later answer'),
    ];
    const whole = readClaudeSnapshot(jsonl(rows), 'id');
    expect(whole?.title).toBe('First request');
    expect(whole?.messages.map((message) => message.text)).toEqual(['First request', 'First answer\n\nLater answer']);
    // A transcript that starts at the boundary has only the summary to carry the earlier context.
    expect(readClaudeSnapshot(jsonl(rows.slice(2)), 'id')?.messages[0].text).toBe('This session is being continued');
  });

  it('reads a Claude transcript again only when its size or modification time moved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-kit-import-cache-'));
    roots.push(root);
    const claudeRoot = join(root, 'claude');
    const path = join(claudeRoot, 'project', 'session.jsonl');
    await mkdir(join(claudeRoot, 'project'), { recursive: true });
    const write = async (prompt: string, seconds: number) => {
      await writeFile(path, jsonl([turn(root, 'u', null, 'user', prompt)]));
      await utimes(path, seconds, seconds);
    };
    const cache: TranscriptCache = new Map();
    const codex: typeof withCodex = async () => {
      throw new Error('not installed');
    };
    const titles = async () =>
      (await discoverExternalSessions(root, { claudeRoot, codex, cache })).sessions.map((session) => session.title);
    await write('First title', 1_000);
    expect(await titles()).toEqual(['First title']);
    await write('Other title', 1_000);
    expect(await titles()).toEqual(['First title']);
    await write('Other title', 2_000);
    expect(await titles()).toEqual(['Other title']);
  });

  it('discovers only the selected project, handles aliases and corrupt files, and leaves every source unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-kit-import-'));
    roots.push(root);
    const cwd = join(root, 'project');
    const alias = join(root, 'alias');
    const claudeRoot = join(root, 'claude');
    const dir = join(claudeRoot, 'encoded-or-hashed-project');
    await mkdir(cwd);
    await symlink(cwd, alias, 'dir');
    await mkdir(dir, { recursive: true });
    const source = join(dir, 'session.jsonl');
    const original = jsonl([
      turn(alias, 'u', null, 'user', 'Keep this original'),
      { ...turn(join(alias, 'subfolder'), 'a', 'u', 'assistant', 'Original answer'), sessionId: 'resumed-id' },
    ]);
    await writeFile(source, original, { mode: 0o444 });
    await writeFile(join(dir, 'bad.jsonl'), '{incomplete');
    await writeFile(join(dir, 'unrelated.jsonl'), jsonl([turn(root, 'u', null, 'user', 'Other project')]));
    await mkdir(join(claudeRoot, 'another-project'));
    await writeFile(join(claudeRoot, 'another-project', 'bad.jsonl'), '{incomplete');
    const codex: typeof withCodex = async () => {
      throw new Error('not installed');
    };
    const discovered = await discoverExternalSessions(cwd, { claudeRoot, codex });
    expect(discovered.sessions).toHaveLength(1);
    expect(discovered.skipped).toBe(1);
    expect(discovered.unavailable).toEqual(['codex']);
    expect(await readFile(source, 'utf8')).toBe(original);

    // The real pi SDK writes, reopens and continues the independent imported history.
    expect(discovered.sessions[0].messages).toEqual([]);
    const selected = await discoverExternalSessions(cwd, { claudeRoot, codex, key: discovered.sessions[0].key });
    expect(selected.unavailable).toEqual([]);
    const snapshot = selected.sessions[0];
    expect(snapshot.nativeId).toBe('session');
    const imported = await importHistory(
      cwd,
      snapshot.title,
      snapshot.messages,
      { sourceId: snapshot.nativeId },
      join(root, 'pi'),
    );
    const pi = await loadPi();
    const manager = pi.SessionManager.open(imported.path);
    expect(manager.getSessionId()).not.toBe(snapshot.nativeId);
    expect(manager.getSessionName()).toBe(snapshot.title);
    expect(manager.getBranch().some((entry) => entry.type === 'message' && entry.message.role === 'user')).toBe(true);
    manager.appendMessage({ role: 'user', content: 'Continue in pi', timestamp: Date.now() });
    expect(
      pi.SessionManager.open(imported.path)
        .getBranch()
        .filter((entry) => entry.type === 'message'),
    ).toHaveLength(3);
    expect(manager.buildSessionProjection().messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(await readFile(source, 'utf8')).toBe(original);
  });

  it('keeps Claude tool results on the assistant side, caps payloads and tolerates a broken final record', () => {
    const output = `HEAD${'x'.repeat(20_000)}TAIL`;
    const rows = [
      turn('/project', 'u', null, 'user', 'Build it'),
      turn('/project', 'a', 'u', 'assistant', [{ type: 'tool_use', name: 'Read', input: { output } }]),
      turn('/project/subfolder', 'r', 'a', 'user', [{ type: 'tool_result', content: output }]),
      { ...turn('/project', 'meta', 'r', 'user', 'housekeeping'), isMeta: true },
      { ...turn('/project', 'error', 'meta', 'assistant', 'API error'), isApiErrorMessage: true },
      turn('/project', 'done', 'error', 'assistant', 'Finished'),
    ];
    const text = jsonl(rows);
    const snapshot = readClaudeSnapshot(text + '{broken', 'filename-id');
    expect(snapshot?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const imported = snapshot!.messages[1].text;
    expect(imported).toContain('HEAD');
    expect(imported).toContain('TAIL');
    expect(imported).toContain('characters omitted');
    expect(imported).toContain('Finished');
    expect(imported).not.toMatch(/housekeeping|API error/);
    expect(imported.length).toBeLessThan(17_000);
    expect(() => readClaudeSnapshot(text + '{broken\n{}\n', 'filename-id')).toThrow('Malformed record');
  });

  it('persists and reopens a user-only import with the installed pi SDK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-kit-import-user-only-'));
    roots.push(root);
    const imported = await importHistory(
      root,
      `Interrupted ghp_${'a'.repeat(36)}`,
      [{ role: 'user', text: 'An unanswered prompt', timestamp: 1 }],
      {},
      join(root, 'pi'),
    );
    const pi = await loadPi();
    const manager = pi.SessionManager.open(imported.path);
    expect(manager.getSessionName()).toContain('[redacted github token');
    expect(manager.getSessionName()).not.toContain('ghp_');
    expect(manager.buildSessionProjection().messages).toMatchObject([
      { role: 'user', content: 'An unanswered prompt' },
    ]);
  });

  it('revalidates only the selected Codex history during import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-kit-import-selection-'));
    roots.push(root);
    const call = vi.fn(async (method: string) => {
      if (method === 'thread/list')
        return {
          data: ['selected', 'other'].map((id) => ({ id, cwd: root, updatedAt: 1, preview: id })),
          nextCursor: null,
        };
      if (method === 'thread/read') return { thread: { updatedAt: 1 } };
      return {
        data: [{ item: { type: 'userMessage', content: [{ type: 'text', text: 'Selected context' }] } }],
        nextCursor: null,
      };
    });
    const codex: typeof withCodex = (use) => use(call);
    const result = await discoverExternalSessions(root, {
      claudeRoot: root,
      codex,
      key: fingerprint(['codex', 'selected']),
    });
    expect(result.sessions.map((snapshot) => snapshot.nativeId)).toEqual(['selected']);
    expect(call.mock.calls.map(([method]) => method)).toEqual(['thread/list']);
    await loadCodexSnapshot(result.sessions[0], codex);
    expect(call.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2);
  });

  it('reads paginated Codex items exactly once and rejects changing source history', async () => {
    const snapshot: ExternalSnapshot = {
      key: fingerprint('source'),
      source: 'codex',
      nativeId: 'native-id',
      title: 'Codex chat',
      updatedAt: 1000,
      fingerprint: fingerprint('version'),
      messages: [],
    };
    let reply = 'Done';
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: { updatedAt: 1 } };
      return params['cursor']
        ? { data: [{ item: { type: 'agentMessage', text: reply } }], nextCursor: null }
        : {
            data: [{ item: { type: 'userMessage', content: [{ type: 'text', text: 'Do it' }] } }],
            nextCursor: 'page2',
          };
    });
    const reader: typeof withCodex = (use) => use(call);
    const first = await loadCodexSnapshot(snapshot, reader);
    expect(first.messages.map((message) => message.text)).toEqual(['Do it', 'Done']);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'thread/read',
      'thread/items/list',
      'thread/items/list',
      'thread/read',
    ]);
    expect(call.mock.calls.some(([method]) => /resume|start/.test(method))).toBe(false);
    reply = 'A second source change in the same second';
    expect((await loadCodexSnapshot(snapshot, reader)).fingerprint).not.toBe(first.fingerprint);
    call.mockImplementation(async () => ({ thread: { updatedAt: 2 } }));
    await expect(loadCodexSnapshot(snapshot, reader)).rejects.toThrow('changed');
  });

  it('detects local Codex changes within the same metadata second before loading history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-kit-import-codex-stamp-'));
    roots.push(root);
    const path = join(root, 'rollout.jsonl');
    await writeFile(path, 'first');
    // Observed with CLI 0.165.0: list uses database time, read uses the last event,
    // and items/list may return -32601 even though it appears in the generated protocol.
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/list') return { data: [{ id: 'native', cwd: root, updatedAt: 2, path }] };
      if (method === 'thread/items/list') throw new CodexReadError('unknown variant `thread/items/list`', -32601);
      return {
        thread: {
          updatedAt: 1,
          ...(params['includeTurns']
            ? {
                turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Native context' }] }] }],
              }
            : {}),
        },
      };
    });
    const reader: typeof withCodex = (use) => use(call);
    const first = (await discoverExternalSessions(root, { claudeRoot: root, codex: reader })).sessions[0];
    expect((await loadCodexSnapshot(first, reader)).messages[0].text).toBe('Native context');
    call.mockClear();
    await utimes(path, 1_000, 1_000);
    const second = (await discoverExternalSessions(root, { claudeRoot: root, codex: reader })).sessions[0];
    expect(first.fingerprint).not.toBe(second.fingerprint);
    await expect(loadCodexSnapshot(first, reader)).rejects.toThrow('changed');
    expect(call.mock.calls).toHaveLength(1);
  });

  it('falls back only on the native unknown-method code, including unknown-variant replies', async () => {
    const snapshot: ExternalSnapshot = {
      key: 'key',
      source: 'codex',
      nativeId: 'native',
      title: 'Chat',
      updatedAt: 1000,
      fingerprint: 'version',
      messages: [],
    };
    let code = -32601;
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/items/list') throw new CodexReadError('unknown variant `thread/items/list`', code);
      return {
        thread: {
          updatedAt: 1,
          ...(params['includeTurns']
            ? {
                turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Legacy context' }] }] }],
              }
            : {}),
        },
      };
    });
    const reader: typeof withCodex = (use) => use(call);
    expect((await loadCodexSnapshot(snapshot, reader)).messages[0].text).toBe('Legacy context');
    expect(call).toHaveBeenCalledWith('thread/read', { threadId: 'native', includeTurns: true });
    call.mockClear();
    code = -32600;
    expect((await loadCodexSnapshot(snapshot, reader)).messages[0].text).toBe('Legacy context');
    call.mockClear();
    code = -32602;
    await expect(loadCodexSnapshot(snapshot, reader)).rejects.toMatchObject({ code: -32602 });
    expect(call).not.toHaveBeenCalledWith('thread/read', { threadId: 'native', includeTurns: true });
  });

  it('initializes the native Codex transport, reads without resuming, and closes its process', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const methods: string[] = [];
    child.stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString()) as { id?: number; method: string };
      methods.push(request.method);
      if (request.id !== undefined)
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { data: [] } }) + '\n'));
    });
    expect(await withCodex((call) => call('thread/list', { cwd: '/project' }))).toEqual({ data: [] });
    expect(methods).toEqual(['initialize', 'initialized', 'thread/list']);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed native replies and closes the transport rather than leaving a hanging reader', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    child.stdin.on('data', () => queueMicrotask(() => child.stdout.write('invalid JSON\n')));
    await expect(withCodex((call) => call('thread/list', {}))).rejects.toThrow('Invalid response');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('preserves native JSON-RPC error codes', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    child.stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString()) as { id?: number; method: string };
      if (request.id !== undefined)
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              id: request.id,
              ...(request.method === 'initialize'
                ? { result: {} }
                : { error: { code: -32601, message: 'unknown variant' } }),
            }) + '\n',
          ),
        );
    });
    await expect(withCodex((call) => call('thread/items/list', {}))).rejects.toMatchObject({ code: -32601 });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('preserves historical Codex tool outputs as text and excludes runtime prompts and reasoning', () => {
    const messages = codexMessages([
      { item: { type: 'hookPrompt', fragments: ['runtime instructions'] } },
      { item: { type: 'reasoning', content: ['private reasoning'] } },
      { item: { type: 'commandExecution', command: 'ls', aggregatedOutput: 'README.md' } },
      { item: { type: 'imageGeneration', result: 'PRIVATE_BASE64'.repeat(10_000) } },
      { item: { type: 'fileChange', changes: [{ path: 'app.ts', diff: 'PRIVATE_DIFF'.repeat(10_000) }] } },
      { item: { type: 'userMessage', content: [{ type: 'image', url: 'private-image' }] } },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain('README.md');
    expect(messages[0].text).toContain('app.ts');
    expect(JSON.stringify(messages)).not.toMatch(
      /private-image|private reasoning|runtime instructions|PRIVATE_BASE64|PRIVATE_DIFF/,
    );
  });
});
