import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { redact } from '@pi-kit/protocol';
import { loadPi } from './load-pi';

/** A session file read through `SessionManager`: the active branch, root to leaf. */
export interface PiSessionContents {
  id: string;
  path: string | undefined;
  cwd: string;
  name: string | undefined;
  leafId: string | null;
  parentSessionPath: string | undefined;
  entries: PiSessionEntry[];
}

/** The entries of a session (all branches, file order) and its current leaf. */
export interface PiTreeSource {
  entries: PiSessionEntry[];
  leafId: string | null;
  path: string | undefined;
}

export interface NewPiSession {
  id: string;
  /** Where pi writes the file; it does not exist until the session has a message. */
  path: string;
  cwd: string;
}

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

/** Reads a session file without opening an `AgentSession` (no extensions, no MCP servers). */
export async function readSession(path: string): Promise<PiSessionContents> {
  const pi = await loadPi();
  const manager = pi.SessionManager.open(path);
  return {
    id: manager.getSessionId(),
    path: manager.getSessionFile(),
    cwd: manager.getCwd(),
    name: manager.getSessionName(),
    leafId: manager.getLeafId(),
    parentSessionPath: manager.getHeader()?.parentSession,
    entries: manager.getBranch() as unknown as PiSessionEntry[],
  };
}

/** `leafHint` stands in for the leaf the app last moved to; a session without a file (a draft) is empty. */
export async function readTree(sessionPath: string, leafHint?: string): Promise<PiTreeSource> {
  if (!existsSync(sessionPath)) return { entries: [], leafId: null, path: undefined };
  const pi = await loadPi();
  const manager = pi.SessionManager.open(sessionPath);
  const leafId = leafHint && manager.getEntry(leafHint) ? leafHint : manager.getLeafId();
  return { entries: manager.getEntries() as unknown as PiSessionEntry[], leafId, path: sessionPath };
}

export async function createSession(cwd: string, id: string): Promise<NewPiSession> {
  const pi = await loadPi();
  const manager = pi.SessionManager.create(cwd, undefined, { id });
  return { id: manager.getSessionId(), path: manager.getSessionFile() as string, cwd };
}

/** Writes history into a fresh pi file without opening the source in pi or loading any project resources. */
export async function importHistory(
  cwd: string,
  title: string,
  messages: readonly ImportedMessage[],
  origin: Record<string, unknown>,
  sessionDir?: string,
): Promise<NewPiSession> {
  const pi = await loadPi();
  const manager = pi.SessionManager.create(cwd, sessionDir);
  try {
    manager.appendCustomEntry('pi-kit.import', origin);
    for (const message of messages) {
      if (message.role === 'user') {
        manager.appendMessage({ role: 'user', content: message.text, timestamp: message.timestamp });
      } else {
        manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: message.text }],
          timestamp: message.timestamp,
          api: 'openai-completions',
          provider: 'imported',
          model: 'history',
          stopReason: 'stop',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
      }
    }
    const settings = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false });
    const provider = settings.getDefaultProvider();
    const model = settings.getDefaultModel();
    if (provider && model) manager.appendModelChange(provider, model);
    manager.appendSessionInfo(redact(title));
    const path = manager.getSessionFile();
    if (!path || !existsSync(path)) throw new Error('The installed pi SDK did not persist the imported conversation.');
    return { id: manager.getSessionId(), path, cwd };
  } catch (error) {
    const path = manager.getSessionFile();
    if (path && existsSync(path)) unlinkSync(path);
    throw error;
  }
}

/** `/fork` outside the TUI: a new session in `targetCwd` with the source's full history. */
export async function forkSession(sourcePath: string, targetCwd: string): Promise<NewPiSession> {
  const pi = await loadPi();
  const manager = pi.SessionManager.forkFrom(sourcePath, targetCwd);
  return { id: manager.getSessionId(), path: manager.getSessionFile() as string, cwd: targetCwd };
}

/**
 * `/clone`: a new session file holding the path from the root to `entryId` (default: the current leaf). Done on a
 * throwaway manager, because `createBranchedSession` switches its manager over to the new file.
 */
export async function cloneSession(sourcePath: string, entryId?: string): Promise<NewPiSession> {
  const pi = await loadPi();
  const source = pi.SessionManager.open(sourcePath);
  const leaf = entryId ?? source.getLeafId();
  if (!leaf) throw new Error('The session has no entries to clone.');
  const path = source.createBranchedSession(leaf);
  if (!path) throw new Error('pi did not create a session file.');
  const clone = pi.SessionManager.open(path);
  return { id: clone.getSessionId(), path, cwd: clone.getCwd() };
}

/** Writes `session_info` (what `/name` does); false if there is no file to write to yet. */
export async function nameSession(sessionPath: string, name: string): Promise<boolean> {
  if (!existsSync(sessionPath)) return false;
  const pi = await loadPi();
  pi.SessionManager.open(sessionPath).appendSessionInfo(name);
  return true;
}

/** Removes a session file the way pi's session picker does: `trash` if it is installed, else unlink. */
export function trashSession(path: string): 'trash' | 'unlink' | 'missing' {
  if (!existsSync(path)) return 'missing';
  const args = path.startsWith('-') ? ['--', path] : [path];
  const result = spawnSync('trash', args, { encoding: 'utf-8' });
  if (result.status === 0 || !existsSync(path)) return 'trash';
  unlinkSync(path);
  return 'unlink';
}
