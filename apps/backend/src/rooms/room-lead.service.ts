import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  PlaybookSummary,
  PostRoomMessage,
  RoomDetail,
  RoomEvent,
  RoomImage,
  RoomLeadState,
  RoomTaskAnswer,
  RoomTaskQuestion,
  UpdateRoom,
  PlaybookAgentSettings,
} from '@pi-kit/protocol';
import { AguiService } from '../agui/agui.service';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { type FoundRoom, RoomsRepository } from '../db/rooms.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { ComposioConnectService } from '../mcp/composio/composio-connect.service';
import { RoomAgents } from './room-agents';
import { RoomBus } from './room-bus';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomQuestions, type WorkerAnswers } from './room-questions';
import { RoomLive } from './room-live';
import { RoomRuns, type RunCause } from './room-runs';
import { ROOM_MEMORY_INSTRUCTIONS } from './room-memory-instructions';

export const NO_ROOM = 'No room with this id.';
export const LEAD_BUSY = 'The lead is still answering. Send again when it is done, or post without prompting it.';
export const LEAD_WAITS = 'The lead waits for your answer to its question first.';
export const NO_LEAD_QUESTION = 'The lead asks nothing with this id.';

export interface LeadPlaybooks {
  briefing(found: FoundRoom): Promise<string | undefined>;
  extras(found: FoundRoom): Promise<Pick<RoomDetail, 'stages' | 'actions' | 'memory'>>;
  settings(found: FoundRoom, who: 'lead'): Promise<PlaybookAgentSettings | undefined>;
}

@Injectable()
export class RoomLeadService implements OnModuleInit, OnApplicationShutdown {
  static readonly AGENT_TURN_LIMIT = 12;
  private readonly draining = new Set<string>();
  private readonly activeWake = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private readonly turns = new Map<string, Promise<void>>();
  private assistant:
    | {
        briefing(found: FoundRoom): Promise<string | undefined>;
        acknowledgeBriefing?(roomId: string, text: string): void;
        initialCwd?(found: FoundRoom): Promise<string>;
        prepare(found: FoundRoom, threadId: string): Promise<string>;
        canWake(found: FoundRoom): Promise<boolean>;
        enabled(): Promise<boolean>;
      }
    | undefined;
  private readonly briefed = new Set<string>();
  /** Rooms whose playbook changed since the lead's last turn: the next prompt carries the new briefing. */
  private readonly rebrief = new Set<string>();
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
    private readonly files: RoomPlaybookFiles,
    private readonly composio: ComposioConnectService,
    private readonly live: RoomLive,
    @Optional() private readonly runs?: RoomRuns,
  ) {}

  setPlaybooks(playbooks: LeadPlaybooks): void {
    this.playbooks = playbooks;
  }

  async onModuleInit(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.sessions.setReadOnlyThreads(async (threadId) =>
      (await this.rooms.isLead(threadId))
        ? 'ask-owner'
        : (await this.consults.isConsultThread(threadId))
          ? 'refuse'
          : undefined,
    );
    await this.rooms.clearLeadQuestions();
    await this.rooms.recoverWakes();
    this.timer = setInterval(() => {
      void this.resumePending().catch(() => undefined);
    }, 1000);
    this.timer.unref();
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
      folder: this.files.roomFolder(roomId) ?? null,
      mode: found.mode,
      paused: found.paused,
      rehearsal: found.rehearsal,
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

  setAssistant(assistant: NonNullable<RoomLeadService['assistant']>): void {
    this.assistant = assistant;
  }
  async proactive(roomId: string): Promise<boolean> {
    return this.assistant ? this.assistant.canWake(await this.found(roomId)) : true;
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const roomId of this.turns.keys()) this.questions.cancel(this.key(roomId));
    await Promise.allSettled(
      [...this.turns.keys()].map(async (roomId) => {
        const found = await this.rooms.get(roomId);
        if (found?.leadThreadId) await this.sessions.abort(found.leadThreadId);
      }),
    );
    await Promise.allSettled([...this.turns.values()]);
  }
  pending(roomId: string): Promise<number> {
    return this.rooms.pendingWakes(roomId);
  }
  async resumePending(): Promise<void> {
    for (const id of await this.rooms.queuedRooms()) await this.drain(id);
  }
  async post(roomId: string, message: PostRoomMessage, sourceKey: string = randomUUID()): Promise<RoomEvent> {
    const found = await this.found(roomId);
    if (message.route === 'lead' && found.leadQuestions.length) throw new ConflictException(LEAD_WAITS);
    if (message.route !== 'lead')
      return this.bus.record(roomId, { kind: 'message', actor: 'owner', text: message.text });
    const { event, fresh } = await this.rooms.acceptMessage(roomId, message, sourceKey);
    if (fresh) this.bus.emit(roomId, { type: 'event', event });
    await this.rooms.setAgentTurns(roomId, 0);
    await this.drain(roomId);
    return event;
  }

  async roomPlaybooks(roomId: string): Promise<PlaybookSummary[]> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    return this.files.list(this.files.place(await this.agents.projectFolder(found), roomId));
  }

  async update(roomId: string, change: UpdateRoom): Promise<RoomDetail> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    if (change.title !== undefined && change.title !== found.room.title) {
      await this.rooms.setTitle(roomId, change.title);
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: `You renamed the room to “${change.title}”.`,
      });
    }
    if (change.playbook !== undefined && change.playbook !== found.playbook) {
      if (this.state(roomId) === 'working') throw new ConflictException(LEAD_BUSY);
      let stage: string | null = null;
      if (change.playbook)
        stage =
          this.files.loadOrConflict(this.files.place(await this.agents.projectFolder(found), roomId), change.playbook)
            .config.stages[0] ?? null;
      await this.rooms.setPlaybook(roomId, change.playbook, stage);
      if (change.playbook) await this.rooms.setMode(roomId, 'assisted');
      this.rebrief.add(roomId);
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: change.playbook
          ? `You attached the playbook “${change.playbook}”: the room is Assisted${stage ? ` and at its first stage “${stage}”` : ''}.`
          : 'You removed the playbook.',
      });
    }
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
    if (change.rehearsal !== undefined && change.rehearsal !== found.rehearsal) {
      await this.rooms.setRehearsal(roomId, change.rehearsal);
      if (found.playbook) this.rebrief.add(roomId);
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: change.rehearsal
          ? 'You started a rehearsal: safe outputs only pretend to run, even those that run at once. Nothing goes out.'
          : 'You ended the rehearsal: safe outputs run again.',
      });
    }
    const detail = await this.detail(roomId);
    this.bus.emit(roomId, {
      type: 'room',
      title: detail.room.title,
      mode: detail.mode,
      paused: detail.paused,
      rehearsal: detail.rehearsal,
      stage: detail.stage,
      playbook: detail.playbook,
    });
    if (!detail.paused) void this.drain(roomId);
    return detail;
  }

  async found(roomId: string): Promise<FoundRoom> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    return found;
  }

  async archive(roomId: string, now = Date.now()): Promise<void> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    this.questions.cancel(this.key(roomId));
    if (found.leadThreadId && this.state(roomId) === 'working')
      await this.sessions.abort(found.leadThreadId).catch(() => undefined);

    await this.rooms.archive(roomId, now);
  }

  rebriefNext(roomId: string): void {
    this.rebrief.add(roomId);
  }

  async nudge(
    roomId: string,
    text: string,
    cause: RunCause = { kind: 'agent', title: text },
    sourceKey?: string,
  ): Promise<void> {
    await this.found(roomId);
    await this.rooms.enqueueWake(roomId, text, cause, sourceKey);
    await this.drain(roomId);
  }

  private async drain(roomId: string): Promise<void> {
    if (this.stopping || this.state(roomId) === 'working' || this.draining.has(roomId)) return;
    this.draining.add(roomId);
    try {
      const found = await this.rooms.get(roomId);
      if (!found || found.paused || found.leadQuestions.length || this.state(roomId) === 'working') return;
      if (this.assistant && !(await this.assistant.enabled())) return;
      const next = await this.rooms.nextWake(roomId);
      if (!next) return;
      if (['schedule', 'poll'].includes(next.cause.kind) && !(await this.proactive(roomId))) return;
      if (next.cause.kind === 'agent' && found.agentTurns >= RoomLeadService.AGENT_TURN_LIMIT) {
        await this.rooms.setPaused(roomId, true);
        await this.bus.record(roomId, {
          kind: 'note',
          actor: 'coordinator',
          text: 'Paused after twelve agent turns. Review the room and resume to continue.',
        });
        this.bus.emit(roomId, { type: 'room', mode: found.mode, paused: true });
        return;
      }
      if (!(await this.rooms.claimWake(next.id))) return;
      await this.rooms.setAgentTurns(roomId, next.cause.kind === 'agent' ? found.agentTurns + 1 : 0);
      this.activeWake.set(roomId, next.id);
      this.prompt(roomId, next.text, next.images, next.cause);
    } finally {
      this.draining.delete(roomId);
    }
  }

  prompt(
    roomId: string,
    text: string,
    images: readonly RoomImage[] = [],
    cause: RunCause = { kind: 'owner', title: text },
  ): boolean {
    if (this.state(roomId) === 'working') return false;
    this.setState(roomId, 'working');
    const turn = this.answer(roomId, text, images, cause);
    this.turns.set(roomId, turn);
    void turn
      .finally(() => {
        if (this.turns.get(roomId) === turn) this.turns.delete(roomId);
      })
      .catch(() => undefined);
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
    return await this.createLead(
      roomId,
      found.room.title,
      this.assistant?.initialCwd
        ? await this.assistant.initialCwd(found)
        : found.room.repository
          ? await this.agents.projectFolder(found)
          : (this.files.workspace(roomId) ?? (await this.agents.projectFolder(found))),
    );
  }

  private async answer(roomId: string, text: string, images: readonly RoomImage[], cause: RunCause): Promise<void> {
    let outcome: { state: 'done' | 'failed' | 'stopped'; summary: string | null } = { state: 'failed', summary: null };
    let runId: string | undefined;
    let resultSeq: number | undefined;
    const wakeId = this.activeWake.get(roomId);
    let requeued = false;
    const speaking = this.live.turn({ roomId, actor: 'lead' });
    try {
      const found = await this.rooms.get(roomId);
      if (!found) return;
      runId = await this.runs?.start(roomId, cause, found);
      const leadId = found.leadThreadId ?? (await this.prepare(roomId));
      const cwd = this.assistant ? await this.assistant.prepare(found, leadId) : await this.agents.projectFolder(found);
      const known = this.briefed.has(roomId);
      const first = !known && !(await this.rooms.events(roomId)).some((event) => event.actor === 'lead');
      this.briefed.add(roomId);
      // Reload the canonical roster after restart, including membership edits saved before a turn.
      const changed = this.rebrief.delete(roomId);
      const rebrief = (changed || !known) && !first;
      const briefing = first || rebrief ? await this.playbooks?.briefing(found) : undefined;
      if (first || rebrief) await this.agents.configure(leadId, await this.playbooks?.settings(found, 'lead'));
      const prompt = first
        ? this.firstPrompt(
            found.room.title,
            found.room.repository,
            found.summary,
            text,
            briefing,
            await this.composioLine(),
          )
        : rebrief
          ? [
              briefing ??
                'The owner removed the room’s playbook: its participants, tools, safe outputs and stages no longer apply.',
              text,
            ].join('\n\n')
          : text;
      const assistantContext = await this.assistant?.briefing(found);
      const current = await this.rooms.get(roomId);
      if (!current || current.paused) {
        if (current?.paused && wakeId) {
          await this.rooms.requeueWake(wakeId);
          requeued = true;
        }
        outcome = { state: 'stopped', summary: 'The room was paused or archived before its turn started.' };
        return;
      }
      if (wakeId && !(await this.rooms.wakeCurrent(wakeId))) {
        outcome = { state: 'done', summary: 'The commitment changed before its turn started.' };
        return;
      }
      let run = await this.agui.runHeadless(
        leadId,
        [assistantContext, ...(this.assistant ? [`Current time: ${new Date().toISOString()}.`] : []), prompt]
          .filter(Boolean)
          .join('\n\n'),
        {
          cwd,
          images,
          observe: speaking.observe,
        },
      );
      while (run.status === 'interrupted') {
        const questions = RoomQuestions.fromDialogs(this.sessions.pendingDialogs(leadId));
        if (questions.length === 0) break;
        const answers = await this.ask(roomId, questions);
        if (!answers) {
          await this.sessions.abort(leadId).catch(() => undefined);
          await this.bus.record(roomId, { kind: 'note', actor: 'coordinator', text: 'The lead’s turn was stopped.' });
          outcome = { state: 'stopped', summary: null };
          return;
        }
        run = await this.agui.resumeHeadless(leadId, RoomQuestions.toResume(answers), {
          cwd,
          observe: speaking.observe,
        });
      }
      if (run.status === 'interrupted') {
        await this.sessions.abort(leadId).catch(() => undefined);
        await this.bus.record(roomId, {
          kind: 'note',
          actor: 'coordinator',
          text: 'The lead stopped at a question nobody could answer. Its turn was cancelled.',
        });
        outcome = { state: 'stopped', summary: null };
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
        outcome = { state: run.status === 'aborted' ? 'stopped' : 'failed', summary: run.error ?? null };
        return;
      }
      if (assistantContext) this.assistant?.acknowledgeBriefing?.(roomId, assistantContext);
      speaking.end();
      for (const app of await this.agents.apps(leadId))
        await this.bus.record(roomId, { kind: 'app', actor: 'lead', text: app.tool ?? app.serverId, app });
      const reply = await this.agents.lastReply(leadId);
      const result = await this.bus.record(
        roomId,
        reply
          ? { kind: 'message', actor: 'lead', text: reply, workId: wakeId }
          : { kind: 'note', actor: 'coordinator', text: 'The lead finished without a written answer.' },
      );
      resultSeq = result.seq;
      outcome = { state: 'done', summary: reply ?? null };
    } catch (error) {
      outcome = { state: 'failed', summary: error instanceof Error ? error.message : String(error) };
      this.logger.warn(`The lead of room ${roomId} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.bus
        .record(roomId, {
          kind: 'note',
          actor: 'coordinator',
          text: `The lead could not answer: ${error instanceof Error ? error.message : String(error)}`,
        })
        .catch(() => undefined);
    } finally {
      if (this.activeWake.get(roomId) === wakeId) this.activeWake.delete(roomId);
      if (wakeId && !requeued)
        await this.rooms
          .finishWake(wakeId, outcome.state === 'done' ? 'done' : 'failed', resultSeq)
          .catch(() => undefined);
      speaking.end();
      if (runId) {
        const stage = (await this.rooms.get(roomId).catch(() => undefined))?.stage ?? null;
        await this.runs?.end(roomId, runId, outcome.state, outcome.summary, stage).catch(() => undefined);
      }
      this.setState(roomId, outcome.state === 'failed' ? 'error' : 'idle');
      void this.drain(roomId).catch(() => undefined);
    }
  }

  private async ask(roomId: string, questions: RoomTaskQuestion[]): Promise<WorkerAnswers | undefined> {
    await this.rooms.setLeadQuestions(roomId, questions);
    const waiting = this.questions.ask(this.key(roomId));
    await this.bus.record(roomId, {
      kind: 'note',
      actor: 'coordinator',
      text: `The lead needs you: ${RoomLeadService.short(questions[0]?.title ?? 'it asks a question.')}`,
    });
    this.bus.emit(roomId, { type: 'lead', state: 'working', questions });
    await this.runs?.waiting(roomId, true);
    try {
      return await waiting;
    } finally {
      await this.runs?.waiting(roomId, false).catch(() => undefined);
      await this.rooms.setLeadQuestions(roomId, []).catch(() => undefined);
      this.bus.emit(roomId, { type: 'lead', state: 'working', questions: [] });
    }
  }

  /** The question card shows the whole call; the room's note only names it. */
  private static short(text: string): string {
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }

  private key(roomId: string): string {
    return `lead:${roomId}`;
  }

  private async createLead(roomId: string, title: string, cwd: string): Promise<string> {
    const detail = await this.threads.create(cwd, `Room lead: ${title}`.slice(0, 200), undefined, undefined, {
      internal: true,
      onId: async (threadId) => await this.rooms.setLead(roomId, threadId),
    });
    return detail.id;
  }

  private async composioLine(): Promise<string | undefined> {
    const reach = await this.composio.forRooms().catch(() => undefined);
    if (!reach) return undefined;
    return `Through Composio (the MCP server ${reach.server}) the owner chose these apps: ${reach.apps.join(', ')}. Load COMPOSIO_SEARCH_TOOLS with tool_search, search for what you need, then run the tools it names with COMPOSIO_MULTI_EXECUTE_TOOL; each run asks the owner first.`;
  }

  private firstPrompt(
    title: string,
    repository: string,
    summary: string,
    text: string,
    briefing?: string,
    composio?: string,
  ): string {
    return [
      repository
        ? `You are the lead of the pi-kit room “${title}” for the repository ${repository}.`
        : `You are the personal assistant in the pi-kit room “${title}”. This room needs no Git repository or source thread.`,
      'The owner talks to you here. Answer them and work out how the goal splits into tasks.',
      repository
        ? 'When a piece of work is ready to hand off, call room_propose_task with a title, a brief and acceptance criteria. The owner approves each task before a worker runs it in its own worktree; you are told when its result arrives.'
        : 'Help the owner with their goal, preferences and commitments using room_assistant. This room has no coding workers and needs no repository or source thread.',
      'Host reference files are read-only: do not edit them or run commands that change them. You may save generated reports and other room-owned files with room_assistant action="output"; it writes only to this room’s outputs folder.',
      'Playbooks are optional. To write or change one, read room_playbook_guide, then send both whole files with room_playbook_propose; the owner applies them.',
      'You can use the owner’s connected apps: find their MCP tools with tool_search. Tools that only read run at once; one that may change something (signing an app in, running an action) first asks the owner. A tool with an MCP App shows that app to the owner in the room.',
      composio ?? '',
      ROOM_MEMORY_INSTRUCTIONS,
      briefing ?? '',
      summary ? `The owner shared this purpose and context:\n\n${summary}` : 'The owner shared no summary yet.',
      `The owner says:\n\n${text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private setState(roomId: string, state: RoomLeadState): void {
    if (state === 'idle') this.states.delete(roomId);
    else this.states.set(roomId, state);
    this.bus.emit(roomId, { type: 'lead', state });
  }
}
