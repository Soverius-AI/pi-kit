import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type {
  PostRoomMessage,
  RoomDetail,
  RoomEvent,
  RoomImage,
  RoomLeadState,
  RoomTaskAnswer,
  RoomTaskQuestion,
  UpdateRoom,
} from '@pi-kit/protocol';
import { AguiService } from '../agui/agui.service';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { RoomAgents } from './room-agents';
import { RoomBus } from './room-bus';
import { RoomQuestions, type WorkerAnswers } from './room-questions';

export const NO_ROOM = 'No room with this id.';
export const LEAD_BUSY = 'The lead is still answering. Send again when it is done, or post without prompting it.';
export const LEAD_WAITS = 'The lead waits for your answer to its question first.';
export const NO_LEAD_QUESTION = 'The lead asks nothing with this id.';

type Found = NonNullable<Awaited<ReturnType<RoomsRepository['get']>>>;

export interface LeadPlaybooks {
  briefing(found: Found): Promise<string | undefined>;
  extras(found: Found): Promise<Pick<RoomDetail, 'stages' | 'actions' | 'memory'>>;
}

@Injectable()
export class RoomLeadService implements OnModuleInit {
  static readonly AGENT_TURN_LIMIT = 12;
  private readonly inbox = new Map<string, string[]>();
  private readonly briefed = new Set<string>();
  private readonly logger = new Logger(RoomLeadService.name);
  private readonly states = new Map<string, RoomLeadState>();
  private playbooks: LeadPlaybooks | undefined;

  constructor(
    private readonly rooms: RoomsRepository,
    private readonly threads: ThreadsService,
    private readonly agui: AguiService,
    private readonly sessions: PiSessionService,
    private readonly bus: RoomBus,
    private readonly agents: RoomAgents,
    private readonly questions: RoomQuestions,
    private readonly consults: RoomPlaybooksRepository,
  ) {}

  setPlaybooks(playbooks: LeadPlaybooks): void {
    this.playbooks = playbooks;
  }

  async onModuleInit(): Promise<void> {
    this.sessions.setReadOnlyThreads(
      async (threadId) => (await this.rooms.isLead(threadId)) || (await this.consults.isConsultThread(threadId)),
    );
    await this.rooms.clearLeadQuestions();
  }

  async detail(roomId: string): Promise<RoomDetail> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    return {
      room: found.room,
      summary: found.summary,
      lead: this.state(roomId),
      leadThreadId: found.leadThreadId ?? (await this.prepare(roomId).catch(() => null)),
      projectFolder: found.projectFolder,
      mode: found.mode,
      paused: found.paused,
      playbook: found.playbook,
      stage: found.stage,
      ...((await this.playbooks?.extras(found)) ?? { stages: [], actions: [], memory: [] }),
      leadQuestions: found.leadQuestions,
      events: await this.rooms.events(roomId),
      tasks: await this.rooms.tasks(roomId),
    };
  }

  state(roomId: string): RoomLeadState {
    return this.states.get(roomId) ?? 'idle';
  }

  async post(roomId: string, message: PostRoomMessage): Promise<RoomEvent> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    if (message.route === 'lead' && found.leadQuestions.length) throw new ConflictException(LEAD_WAITS);
    if (message.route === 'lead' && this.state(roomId) === 'working') throw new ConflictException(LEAD_BUSY);
    const event = await this.bus.record(roomId, {
      kind: 'message',
      actor: 'owner',
      text: message.text,
      images: message.images?.length ?? 0,
    });
    if (message.route === 'lead') {
      await this.rooms.setAgentTurns(roomId, 0);
      this.prompt(roomId, message.text, message.images ?? []);
    }
    return event;
  }

  async update(roomId: string, change: UpdateRoom): Promise<RoomDetail> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    if (change.mode && change.mode !== found.mode) {
      await this.rooms.setMode(roomId, change.mode);
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text:
          change.mode === 'assisted'
            ? 'You switched the room to Assisted: the lead answers workers and reviews results before they reach you.'
            : 'You switched the room to Supervised: workers and results come to you.',
      });
    }
    if (change.paused !== undefined && change.paused !== found.paused) {
      await this.rooms.setPaused(roomId, change.paused);
      if (!change.paused) await this.rooms.setAgentTurns(roomId, 0);
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: change.paused
          ? 'You paused the agents: nothing wakes the lead until you resume.'
          : 'You resumed the agents.',
      });
    }
    const detail = await this.detail(roomId);
    this.bus.emit(roomId, { type: 'room', mode: detail.mode, paused: detail.paused, stage: detail.stage });
    if (!detail.paused) void this.drain(roomId);
    return detail;
  }

  async nudge(roomId: string, text: string): Promise<void> {
    const queue = this.inbox.get(roomId) ?? [];
    queue.push(text);
    this.inbox.set(roomId, queue);
    await this.drain(roomId);
  }

  pending(roomId: string): number {
    return this.inbox.get(roomId)?.length ?? 0;
  }

  private async drain(roomId: string): Promise<void> {
    if (this.state(roomId) === 'working' || !this.inbox.get(roomId)?.length) return;
    const found = await this.rooms.get(roomId);
    if (!found || found.paused || this.state(roomId) === 'working') return;
    if (found.agentTurns >= RoomLeadService.AGENT_TURN_LIMIT) {
      await this.rooms.setPaused(roomId, true);
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: `Paused: the agents woke the lead ${found.agentTurns} times in a row without you. Read the room and resume when it should go on.`,
      });
      this.bus.emit(roomId, { type: 'room', mode: found.mode, paused: true });
      return;
    }
    const text = this.inbox.get(roomId)?.shift();
    if (!text) return;
    await this.rooms.setAgentTurns(roomId, found.agentTurns + 1);
    this.prompt(roomId, text);
  }

  prompt(roomId: string, text: string, images: readonly RoomImage[] = []): boolean {
    if (this.state(roomId) === 'working') return false;
    this.setState(roomId, 'working');
    void this.answer(roomId, text, images);
    return true;
  }

  async answerQuestions(roomId: string, body: RoomTaskAnswer): Promise<RoomDetail> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    const open = new Set(found.leadQuestions.map((question) => question.id));
    if (open.size === 0 || body.answers.some((answer) => !open.has(answer.id)))
      throw new ConflictException(NO_LEAD_QUESTION);
    if (!this.questions.answer(this.key(roomId), body.answers)) {
      await this.rooms.setLeadQuestions(roomId, []);
      throw new ConflictException('The lead no longer waits for this answer.');
    }
    await this.rooms.setLeadQuestions(roomId, []);
    return await this.detail(roomId);
  }

  async prepare(roomId: string): Promise<string> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    if (found.leadThreadId) return found.leadThreadId;
    return await this.createLead(roomId, found.room.title, await this.agents.projectFolder(found));
  }

  private async answer(roomId: string, text: string, images: readonly RoomImage[]): Promise<void> {
    try {
      const found = await this.rooms.get(roomId);
      if (!found) return;
      const cwd = await this.agents.projectFolder(found);
      const leadId = found.leadThreadId ?? (await this.prepare(roomId));
      const first =
        !this.briefed.has(roomId) && !(await this.rooms.events(roomId)).some((event) => event.actor === 'lead');
      this.briefed.add(roomId);
      const briefing = first ? await this.playbooks?.briefing(found) : undefined;
      const prompt = first
        ? this.firstPrompt(found.room.title, found.room.repository, found.summary, text, briefing)
        : text;
      let run = await this.agui.runHeadless(leadId, prompt, { cwd, images });
      while (run.status === 'interrupted') {
        const questions = RoomQuestions.fromDialogs(this.sessions.pendingDialogs(leadId));
        if (questions.length === 0) break;
        const answers = await this.ask(roomId, questions);
        if (!answers) {
          await this.sessions.abort(leadId).catch(() => undefined);
          await this.bus.record(roomId, { kind: 'note', actor: 'coordinator', text: 'The lead’s turn was stopped.' });
          this.setState(roomId, 'idle');
          return;
        }
        run = await this.agui.resumeHeadless(leadId, RoomQuestions.toResume(answers), { cwd });
      }
      if (run.status === 'interrupted') {
        await this.sessions.abort(leadId).catch(() => undefined);
        await this.bus.record(roomId, {
          kind: 'note',
          actor: 'coordinator',
          text: 'The lead stopped at a question nobody could answer. Its turn was cancelled.',
        });
        this.setState(roomId, 'idle');
        return;
      }
      if (run.status !== 'finished') {
        await this.bus.record(roomId, {
          kind: 'note',
          actor: 'coordinator',
          text:
            run.status === 'aborted'
              ? 'The lead’s turn was stopped.'
              : `The lead could not answer: ${run.error ?? 'pi reported an error.'}`,
        });
        this.setState(roomId, run.status === 'aborted' ? 'idle' : 'error');
        return;
      }
      const reply = await this.agents.lastReply(leadId);
      await this.bus.record(
        roomId,
        reply
          ? { kind: 'message', actor: 'lead', text: reply }
          : { kind: 'note', actor: 'coordinator', text: 'The lead finished without a written answer.' },
      );
      this.setState(roomId, 'idle');
    } catch (error) {
      this.logger.warn(`The lead of room ${roomId} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.bus
        .record(roomId, {
          kind: 'note',
          actor: 'coordinator',
          text: `The lead could not answer: ${error instanceof Error ? error.message : String(error)}`,
        })
        .catch(() => undefined);
      this.setState(roomId, 'error');
    }
  }

  private async ask(roomId: string, questions: RoomTaskQuestion[]): Promise<WorkerAnswers | undefined> {
    await this.rooms.setLeadQuestions(roomId, questions);
    const waiting = this.questions.ask(this.key(roomId));
    await this.bus.record(roomId, {
      kind: 'note',
      actor: 'coordinator',
      text: `The lead needs you: ${questions[0]?.title ?? 'it asks a question.'}`,
    });
    this.bus.emit(roomId, { type: 'lead', state: 'working', questions });
    try {
      return await waiting;
    } finally {
      await this.rooms.setLeadQuestions(roomId, []).catch(() => undefined);
      this.bus.emit(roomId, { type: 'lead', state: 'working', questions: [] });
    }
  }

  private key(roomId: string): string {
    return `lead:${roomId}`;
  }

  private async createLead(roomId: string, title: string, cwd: string): Promise<string> {
    const detail = await this.threads.create(cwd, `Room lead: ${title}`.slice(0, 200), undefined, undefined, {
      onId: async (threadId) => await this.rooms.setLead(roomId, threadId),
    });
    const unavailable = await this.agents.sandbox(detail.id);
    if (unavailable)
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: `${unavailable} The lead runs on this computer without it, still read-only.`,
      });
    return detail.id;
  }

  private firstPrompt(title: string, repository: string, summary: string, text: string, briefing?: string): string {
    return [
      `You are the lead of the pi-kit room “${title}” for the repository ${repository}.`,
      'The owner talks to you here. Answer them and work out how the goal splits into tasks.',
      'When a piece of work is ready to hand off, call room_propose_task with a title, a brief and acceptance criteria. The owner approves each task before a worker runs it in its own worktree; you are told when its result arrives.',
      'You are read-only: do not try to edit files or run commands that change anything.',
      briefing ?? '',
      summary
        ? `The owner shared this summary from the thread the room started from:\n\n${summary}`
        : 'The owner shared no summary yet.',
      `The owner says:\n\n${text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private setState(roomId: string, state: RoomLeadState): void {
    if (state === 'idle') this.states.delete(roomId);
    else this.states.set(roomId, state);
    this.bus.emit(roomId, { type: 'lead', state });
    if (state !== 'working') void this.drain(roomId).catch(() => undefined);
  }
}
