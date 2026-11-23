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
    const existing = await this.playbooks.consultThread(request.roomId, request.role);
    const threadId = existing && (await this.threadRows.get(existing)) ? existing : await this.create(request);
    if (this.workspace) request = { ...request, folder: await this.workspace.prepare(request.roomId, threadId) };
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
    const policy = await this.workspace?.execution(request.roomId);
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
        onId: async (threadId) => await this.playbooks.addConsultThread(threadId, request.roomId, request.role),
      },
    );
    return detail.id;
  }

  private firstPrompt(request: ConsultRequest): string {
    return [
      `You are the ${request.role} in the pi-kit room “${request.roomTitle}” for the repository ${request.repository}.`,
      request.instructions || `Give the room your view as ${request.role}.`,
      'The room’s lead asks you questions; answer the lead directly. You are read-only: read the repository to back your answer, but change nothing. Do not ask questions back: say what you assume instead.',
      'Keep it short: findings first, one line each, with file paths and lines where they help. At most 300 words.',
      `The lead asks:\n\n${request.question}`,
    ].join('\n\n');
  }
}
