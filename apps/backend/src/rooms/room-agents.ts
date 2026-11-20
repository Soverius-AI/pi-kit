import { Injectable } from '@nestjs/common';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { ThreadsRepository } from '../db/threads.repository';
import { ThreadsService } from '../threads/threads.service';
import { toplevel } from '../worktree/worktree-git';

@Injectable()
export class RoomAgents {
  constructor(
    private readonly threadRows: ThreadsRepository,
    private readonly threads: ThreadsService,
  ) {}

  async projectFolder(room: { projectFolder: string | null; sourceThreadId: string | null }): Promise<string> {
    if (room.projectFolder) return room.projectFolder;
    const sourceThreadId = room.sourceThreadId;
    const source = sourceThreadId ? await this.threadRows.get(sourceThreadId) : undefined;
    if (!source) throw new Error('The thread this room was started from no longer exists.');
    const folder = source.worktreePath ?? source.cwd;
    return (await toplevel(folder)) ?? folder;
  }

  async sandbox(threadId: string): Promise<string | undefined> {
    try {
      let status = await this.threads.setProtection(threadId, {
        mode: 'sandboxed',
        ...(process.platform === 'win32' ? { experimentalWindowsAccepted: true } : {}),
      });
      for (let tries = 0; (status.state === 'starting' || status.state === 'idle') && tries < 40; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = await this.threads.protectionOf(threadId);
      }
      if (status.state !== 'unavailable' && status.state !== 'setup-required' && status.state !== 'recovery-required')
        return undefined;
      await this.threads.setProtection(threadId, { mode: 'bypass', confirmBypass: true });
      return `The sandbox is not available on this computer${status.reason ? ` (${status.reason})` : ''}.`;
    } catch (error) {
      return `The sandbox is not available on this computer (${error instanceof Error ? error.message : String(error)}).`;
    }
  }

  async lastReply(threadId: string): Promise<string | undefined> {
    const { entries, leafId } = await this.threads.treeSource(threadId);
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    let current: PiSessionEntry | undefined = leafId ? byId.get(leafId) : entries.at(-1);
    for (let guard = 0; current && guard <= entries.length; guard++) {
      const message =
        current.type === 'message'
          ? (current['message'] as { role?: string; content?: unknown; stopReason?: string } | undefined)
          : undefined;
      if (message?.role === 'user') return undefined;
      if (message?.role === 'assistant' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
        const text = this.textOf(message.content).trim();
        if (text) return text.slice(0, 32000);
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return undefined;
  }

  private textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
}
