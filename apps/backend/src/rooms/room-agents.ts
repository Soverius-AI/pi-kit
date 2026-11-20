import { Injectable } from '@nestjs/common';
import { type PiSessionEntry, sessionToMessages } from '@pi-kit/pi-adapter';
import { genUiId, MCP_APPS_ACTIVITY, type McpAppActivity, ROOMS_SANDBOX_SETTING_KEY } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { toplevel } from '../worktree/worktree-git';

@Injectable()
export class RoomAgents {
  private static readonly KEPT_THREADS = 20;
  private readonly mcpResults = new Map<string, Map<string, Record<string, unknown>>>();

  constructor(
    private readonly threadRows: ThreadsRepository,
    private readonly threads: ThreadsService,
    private readonly sessions: PiSessionService,
    private readonly meta: MetaRepository,
  ) {}

  async projectFolder(room: { projectFolder: string | null; sourceThreadId: string | null }): Promise<string> {
    if (room.projectFolder) return room.projectFolder;
    const sourceThreadId = room.sourceThreadId;
    const source = sourceThreadId ? await this.threadRows.get(sourceThreadId) : undefined;
    if (!source) throw new Error('The thread this room was started from no longer exists.');
    const folder = source.worktreePath ?? source.cwd;
    return (await toplevel(folder)) ?? folder;
  }

  /** Starts the thread in the sandbox when the owner turned that on for rooms; answers why it could not. */
  async sandbox(threadId: string): Promise<string | undefined> {
    if ((await this.meta.getSetting(ROOMS_SANDBOX_SETTING_KEY)) !== true) return undefined;
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
    for (const current of (await this.branch(threadId)).reverse()) {
      const message =
        current.type === 'message'
          ? (current['message'] as { role?: string; content?: unknown; stopReason?: string } | undefined)
          : undefined;
      if (message?.role === 'user') return undefined;
      if (message?.role === 'assistant' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
        const text = this.textOf(message.content).trim();
        if (text) return text.slice(0, 32000);
      }
    }
    return undefined;
  }

  /** The thread's current branch, root first. */
  private async branch(threadId: string): Promise<PiSessionEntry[]> {
    const { entries, leafId } = await this.threads.treeSource(threadId);
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    const branch: PiSessionEntry[] = [];
    for (let current = leafId ? byId.get(leafId) : entries.at(-1); current && branch.length <= entries.length;) {
      branch.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch;
  }

  keepMcpResult(threadId: string, toolCallId: string, result: Record<string, unknown>): void {
    const kept = this.mcpResults.get(threadId) ?? new Map<string, Record<string, unknown>>();
    this.mcpResults.delete(threadId);
    this.mcpResults.set(threadId, kept.set(genUiId.mcpApp(toolCallId), result));
    for (const oldest of this.mcpResults.keys()) {
      if (this.mcpResults.size <= RoomAgents.KEPT_THREADS) break;
      this.mcpResults.delete(oldest);
    }
  }

  /** The MCP Apps opened since the thread's last prompt, as the transcript would draw them. */
  async apps(threadId: string): Promise<McpAppActivity[]> {
    const results = this.mcpResults.get(threadId);
    this.mcpResults.delete(threadId);
    const mcpApp = this.sessions.mcpAppLookup(threadId);
    if (!mcpApp) return [];
    const apps: McpAppActivity[] = [];
    for (const message of sessionToMessages(await this.branch(threadId), { mcpApp })) {
      if (message.role === 'user') apps.length = 0;
      else if (message.role === 'activity' && message.activityType === MCP_APPS_ACTIVITY) {
        const result = results?.get(message.id);
        apps.push({ ...(message.content as McpAppActivity), ...(result ? { result } : {}) } as McpAppActivity);
      }
    }
    return apps;
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
