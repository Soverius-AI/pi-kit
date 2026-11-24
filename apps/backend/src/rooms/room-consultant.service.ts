import { createHash } from 'node:crypto';
import type { BaseEvent } from '@ag-ui/core';
import type { PlaybookAgentSettings } from '@pi-kit/protocol';
import { Injectable, Optional } from '@nestjs/common';
import { RoomWorkspace } from './room-workspace.service';
import { AguiService } from '../agui/agui.service';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { RoomAgents } from './room-agents';
import { RoomLive } from './room-live';

export interface ConsultRequest {
  roomId: string;
  roomTitle: string;
  repository: string;
  folder: string;
  role: string;
  instructions: string;
  question: string;
  settings?: PlaybookAgentSettings;
  detached?: boolean;
  observe?: (event: BaseEvent) => void;
}

@Injectable()
export class RoomConsultant {
  private readonly running = new Map<string, Promise<string>>();

  constructor(
    private readonly playbooks: RoomPlaybooksRepository,
    private readonly threadRows: ThreadsRepository,
    private readonly threads: ThreadsService,
    private readonly agui: AguiService,
    private readonly sessions: PiSessionService,
    private readonly agents: RoomAgents,
    private readonly live: RoomLive,
    @Optional() private readonly workspace?: RoomWorkspace,
  ) {}

  async ask(request: ConsultRequest): Promise<string> {
    const key = `${request.roomId}:${request.role}`;
    const before = this.running.get(key) ?? Promise.resolve('');
    const next = before.catch(() => '').then(async () => await this.turn(request));
    this.running.set(key, next);
    try {
      return await next;
    } finally {
      if (this.running.get(key) === next) this.running.delete(key);
    }
  }

  private async turn(request: ConsultRequest): Promise<string> {
    // A changed persona/model gets a fresh conversation, including after a process restart.
    const sessionRole = this.sessionRole(request);
    const existing = await this.playbooks.consultThread(request.roomId, sessionRole);
    const threadId = existing && (await this.threadRows.get(existing)) ? existing : await this.create(request);
    if (this.workspace && !request.detached)
      request = { ...request, folder: await this.workspace.prepare(request.roomId, threadId) };
    const prompt = existing === threadId ? request.question : this.firstPrompt(request);
    await this.agents.configure(threadId, request.settings);
    const speaking = this.live.turn({ roomId: request.roomId, actor: 'consultant', role: request.role });
    const run = await this.agui
      .runHeadless(threadId, prompt, {
        cwd: request.folder,
        observe: (event) => {
          speaking.observe(event);
          request.observe?.(event);
        },
      })
      .finally(() => speaking.end());
    if (run.status === 'interrupted') {
      await this.sessions.abort(threadId).catch(() => undefined);
      return `The ${request.role} consultant stopped to ask a question; consultants cannot ask. Put what it needs into the question.`;
    }
    if (run.status !== 'finished')
      return `The ${request.role} consultant could not answer: ${run.error ?? run.status}.`;
    return (await this.agents.lastReply(threadId)) ?? `The ${request.role} consultant gave no written answer.`;
  }

  private async create(request: ConsultRequest): Promise<string> {
    const policy = request.detached ? undefined : await this.workspace?.execution(request.roomId);
    const cwd = policy?.workspace
      ? (this.workspace?.ensure(request.roomId) ?? request.folder)
      : (policy?.cwd ?? request.folder);
    const detail = await this.threads.create(
      cwd,
      `Room ${request.role}: ${request.roomTitle}`.slice(0, 200),
      undefined,
      undefined,
      {
        internal: true,
        onId: async (threadId) =>
          await this.playbooks.addConsultThread(threadId, request.roomId, this.sessionRole(request)),
      },
    );
    return detail.id;
  }

  private sessionRole(request: ConsultRequest): string {
    return `${request.role}:${createHash('sha256')
      .update(JSON.stringify([request.instructions, request.settings ?? {}]))
      .digest('hex')
      .slice(0, 24)}`;
  }

  private firstPrompt(request: ConsultRequest): string {
    return [
      `You are the ${request.role} in the pi-kit room “${request.roomTitle}”${request.repository ? ` for the repository ${request.repository}` : ' as a personal assistant collaborator'}.`,
      request.instructions || `Give the room your view as ${request.role}.`,
      'The room’s lead asks you questions; answer the lead directly. You are read-only: use the supplied room context and available reference files to back your answer, but change nothing. You do not see the room conversation or its memory unless the lead includes them in its question. Do not ask questions back: say what you assume instead.',
      'Keep it short: findings first, one line each, with file paths and lines where they help. At most 300 words.',
      `The lead asks:\n\n${request.question}`,
    ].join('\n\n');
  }
}
