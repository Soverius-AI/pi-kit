import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { buildSessionTree, type ContextWindowLookup, userMessageText } from '@pi-kit/pi-adapter';
import type { EntryText, NavigateResult, SessionTree } from '@pi-kit/protocol';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';

/**
 * The session graph: reads the thread's tree and moves along it. The transcript
 * follows a leaf change through `PiSessionService.onTreeChanged`, which `PiAgentRunner` turns into a snapshot in
 * the replay log; nothing here talks to AG-UI.
 */
@Injectable()
export class TreeService {
  constructor(
    private readonly threads: ThreadsService,
    private readonly sessions: PiSessionService,
  ) {}

  /** Rows in display order with lanes (`?raw=1` asks for `raw` instead). */
  async tree(id: string): Promise<SessionTree> {
    const source = await this.threads.treeSource(id);
    return buildSessionTree(source.entries, source.leafId, { contextWindow: await this.contextWindows(id) });
  }

  /**
   * The model windows for the context ring: the same lookup the meter and the status bar use
   * (`PiSessionService.contextWindowLookup`, one source of truth). The tree builder is pure, so the lookup comes from here; a model pi
   * no longer knows has no window and its turns draw no ring.
   */
  private async contextWindows(id: string): Promise<ContextWindowLookup | undefined> {
    try {
      await this.threads.openSession(id);
      return this.sessions.contextWindowLookup(id);
    } catch {
      return undefined;
    }
  }

  /** The raw entries for the inspector's "Entries" view, all branches, file order. */
  async raw(id: string): Promise<{ entries: unknown[]; leafId: string | null }> {
    const source = await this.threads.treeSource(id);
    return { entries: source.entries, leafId: source.leafId };
  }

  /** The full text of a user message (the rows only carry 80 characters), for "Edit and branch". */
  async entryText(id: string, entryId: string): Promise<EntryText> {
    const source = await this.threads.treeSource(id);
    const entry = source.entries.find((e) => e.id === entryId);
    if (!entry) throw new NotFoundException(`Entry ${entryId} not found.`);
    const message = entry.type === 'message' ? (entry['message'] as { role?: string; content?: string | { type: string; text?: string }[] }) : undefined;
    const text = message?.role === 'user' ? userMessageText(message.content) : '';
    return { id: entry.id, role: message?.role ?? entry.type, text, parentId: entry.parentId ?? null };
  }

  async navigate(id: string, targetId: string, options: { summarize?: boolean; instructions?: string } = {}): Promise<NavigateResult> {
    await this.threads.openSession(id);
    this.requireIdle(id, 'move along the tree');
    try {
      return await this.sessions.navigate(id, targetId, options);
    } catch (error) {
      throw asHttp(error);
    }
  }

  async label(id: string, targetId: string, label: string | null): Promise<SessionTree> {
    await this.threads.openSession(id);
    this.requireIdle(id, 'label a turn');
    try {
      this.sessions.setLabel(id, targetId, label?.trim() || undefined);
    } catch (error) {
      throw asHttp(error);
    }
    return this.tree(id);
  }

  private requireIdle(id: string, what: string): void {
    if (this.sessions.isStreaming(id) || this.sessions.pendingDialogs(id).length > 0) {
      throw new ConflictException(`Stop the run before you ${what}.`);
    }
  }
}

function asHttp(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return new NotFoundException(message);
  return new ConflictException(message);
}
