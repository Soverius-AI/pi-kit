import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Message, SendMessageRequest, TaskState, type Task } from '@a2a-js/sdk';
import {
  A2A_ROOM_EXTENSION,
  type PlaybookFireResult,
  type PlaybookParticipant,
  type PlaybookPoll,
  type RoomAction,
  type RoomActionDecision,
  type RoomMemoryEntry,
  type PlaybookAgentSettings,
} from '@pi-kit/protocol';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { type FoundRoom, RoomsRepository } from '../db/rooms.repository';
import { PeersService } from '../peers/peers.service';
import { RoomAgents } from './room-agents';
import { RoomA2a } from './room-a2a';
import { RoomA2aAgents } from './room-a2a-agents';
import { RoomA2aClient } from './room-a2a.client';
import { RoomBus } from './room-bus';
import { type ToolCall, type ToolRun, RoomPlaybookTools } from './room-playbook-tools.service';
import { RoomSchedule } from './room-schedule';
import { RoomConsultant } from './room-consultant.service';
import { NO_ROOM, RoomLeadService } from './room-lead.service';
import { RoomPlaybookFiles, type Playbook } from './room-playbook-files.service';
import { RoomPlaybookEditor } from './room-playbook-editor.service';
import { RoomLive } from './room-live';
import { RoomRuns } from './room-runs';

@Injectable()
export class RoomPlaybookService implements OnModuleInit, OnApplicationShutdown {
  static readonly TICK = 15_000;
  static readonly CONSULT_LIMIT = 10 * 60_000;
  private readonly logger = new Logger(RoomPlaybookService.name);
  private static readonly KEEP_OUTPUT = 10 * 60_000;
  private static readonly REHEARSED = 'Rehearsal: it did not run.';
  private static readonly TERMINAL = new Set<TaskState>([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ]);
  private readonly outputs = new Map<string, { at: number; result: ToolRun }>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(
    private readonly rooms: RoomsRepository,
    private readonly store: RoomPlaybooksRepository,
    private readonly playbooks: RoomPlaybookFiles,
    private readonly tools: RoomPlaybookTools,
    private readonly consultant: RoomConsultant,
    private readonly bus: RoomBus,
    private readonly lead: RoomLeadService,
    private readonly agents: RoomAgents,
    private readonly a2a: RoomA2aClient,
    private readonly outside: RoomA2aAgents,
    private readonly peers: PeersService,
    private readonly editor: RoomPlaybookEditor,
    private readonly live: RoomLive,
    @Optional() private readonly runs?: RoomRuns,
  ) {}

  onModuleInit(): void {
    this.lead.setPlaybooks(this);
    this.timer = setInterval(() => void this.tick(), RoomPlaybookService.TICK);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async of(found: FoundRoom): Promise<Playbook | undefined> {
    if (!found.playbook) return undefined;
    return this.playbooks.load(
      this.playbooks.place(await this.agents.projectFolder(found), found.room.id),
      found.playbook,
    );
  }

  async settings(found: FoundRoom, who: 'lead' | 'workers'): Promise<PlaybookAgentSettings | undefined> {
    return (await this.of(found).catch(() => undefined))?.config[who];
  }

  scopes(found: FoundRoom): string[] {
    return [
      `room:${found.room.id}`,
      ...(found.playbook ? [`playbook:${found.room.repository}/${found.playbook}`] : []),
    ];
  }

  async extras(found: FoundRoom): Promise<{
    stages: string[];
    actions: RoomAction[];
    memory: RoomMemoryEntry[];
  }> {
    const [playbook, actions, memory] = await Promise.all([
      this.of(found).catch(() => undefined),
      this.store.actions(found.room.id),
      this.store.memory(this.scopes(found)),
    ]);
    return { stages: playbook?.config.stages ?? [], actions, memory };
  }

  async briefing(found: FoundRoom): Promise<string | undefined> {
    const playbook = await this.of(found);
    if (!playbook) return undefined;
    const { config } = playbook;
    const memory = await this.store.memory(this.scopes(found));
    const line = (name: string, what: string, description: string) => {
      const needs = this.tools.needs(playbook, name);
      return `- ${name} (${what})${needs.length ? `, params: ${needs.join(', ')}` : ''}: ${description}`;
    };
    const lines = [
      ...Object.entries(config.tools).map(([name, tool]) => line(name, 'reads, runs at once', tool.description)),
      ...Object.entries(config['safe-outputs']).map(([name, output]) =>
        line(
          name,
          `${output.mode === 'auto' ? 'writes, runs at once' : 'writes, the owner approves each call'}${output.max ? `, at most ${output.max} a day` : ''}`,
          output.description,
        ),
      ),
    ];
    return [
      `This room follows the playbook “${playbook.name}”: ${playbook.description}`,
      playbook.instructions,
      config.participants.length
        ? `Participants you can consult with room_consult or room_discuss:\n${config.participants.map((participant) => `- ${participant.role}${participant.agent.machine ? ` on ${participant.agent.machine}` : participant.agent.agent ? ` (agent ${participant.agent.agent})` : ''}: ${participant.instructions.split('\n')[0] ?? ''}`).join('\n')}`
        : '',
      lines.length ? `Tools and safe outputs you call with room_call:\n${lines.join('\n')}` : '',
      config.stages.length
        ? `Stages: ${config.stages.join(' → ')}. The room is at “${found.stage ?? config.stages[0]}”. Move on with room_advance${
            Object.keys(config.gates).length
              ? `; the owner approves moving into ${Object.entries(config.gates)
                  .filter(([, gate]) => gate === 'owner')
                  .map(([stage]) => stage)
                  .join(', ')}`
              : ''
          }.`
        : '',
      found.rehearsal
        ? 'The room is rehearsing: safe outputs only pretend to run, even those that run at once, so nothing goes out. Go through the workflow as if they had worked.'
        : '',
      'Keep notes the room should not lose with room_note: decisions, the current spec, what was reviewed. Scope "playbook" notes carry over to later rooms of this playbook.',
      memory.length
        ? `Notes so far:\n${memory.map((entry) => `- [${entry.scope}] ${entry.key}: ${entry.text}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async call(threadId: string, input: { tool: string; params: Record<string, string>; reason: string; page?: number }) {
    const { found, playbook } = await this.leadRoom(threadId);
    const output = this.tools.output(playbook, input.tool);
    const call = this.tools.prepare(playbook, input.tool, input.params, this.context(found));
    if (
      output?.max &&
      (await this.store.countActions(found.room.id, input.tool, Date.now() - 86_400_000)) >= output.max
    )
      return `${input.tool} may run at most ${output.max} times a day, and that is used up. Tell the owner instead.`;
    if (output?.mode === 'auto') {
      const action = await this.store.insertAction({
        id: randomUUID(),
        roomId: found.room.id,
        kind: 'call',
        name: input.tool,
        summary: input.reason,
        payload: { ...call },
      });
      const step = await this.runs?.step(found.room.id, {
        kind: 'output',
        name: input.tool,
        detail: this.tools.describe(call),
      });
      if (found.rehearsal) {
        await this.runs?.settle(found.room.id, step, 'done', RoomPlaybookService.REHEARSED);
        await this.store.decide(found.room.id, action.id, 'done', RoomPlaybookService.REHEARSED);
        await this.bus.record(found.room.id, {
          kind: 'note',
          actor: 'coordinator',
          text: `Rehearsal: ${input.tool} did not run. It would have run ${this.tools.describe(call)}`,
        });
        return `Rehearsal: ${input.tool} did not run, nothing went out. It would have run ${this.tools.describe(call)}. Go on as if it had worked.`;
      }
      const result = await this.run(found, call, input.tool, input.reason);
      await this.runs?.settle(found.room.id, step, result.ok ? 'done' : 'failed', result.output);
      await this.store.decide(found.room.id, action.id, result.ok ? 'done' : 'failed', this.tools.cut(result.output));
      return this.reply(result, this.tools.cut(result.output));
    }
    if (output) {
      const action = await this.draft(
        found,
        { kind: 'call', name: input.tool, summary: input.reason, payload: { ...call } },
        `Drafted ${input.tool} for your approval: ${input.reason}`,
      );
      await this.runs?.step(found.room.id, {
        kind: 'output',
        name: input.tool,
        detail: this.tools.describe(call),
        state: 'waiting',
        actionId: action.id,
      });
      return `Drafted as action ${action.id}. Nothing ran: the owner approves or discards it, and you are told the result.`;
    }
    const key = `${found.room.id}:${JSON.stringify(call)}`;
    const kept = (input.page ?? 1) > 1 ? this.outputs.get(key) : undefined;
    const fresh = !(kept && Date.now() - kept.at < RoomPlaybookService.KEEP_OUTPUT);
    const step = fresh
      ? await this.runs?.step(found.room.id, { kind: 'tool', name: input.tool, detail: this.tools.describe(call) })
      : undefined;
    const result = fresh ? await this.run(found, call, input.tool, input.reason) : kept.result;
    await this.runs?.settle(found.room.id, step, result.ok ? 'done' : 'failed', result.output);
    if (!kept) {
      this.outputs.delete(key);
      this.outputs.set(key, { at: Date.now(), result });
      while (this.outputs.size > 16) this.outputs.delete(this.outputs.keys().next().value as string);
    }
    return this.reply(result, this.tools.page(result.output, input.page ?? 1));
  }

  async consult(threadId: string, input: { role: string; question: string }): Promise<string> {
    const { found, playbook } = await this.leadRoom(threadId);
    return await this.ask(found, playbook, input.role, input.question);
  }

  async discuss(threadId: string, input: { question: string; roles?: string[] }): Promise<string> {
    const { found, playbook } = await this.leadRoom(threadId);
    const roles = input.roles?.length
      ? input.roles
      : playbook.config.participants.map((participant) => participant.role);
    if (!roles.length) return 'The playbook names no participants.';
    const answers = await Promise.all(
      roles.map(async (role) => `## ${role}\n\n${await this.ask(found, playbook, role, input.question)}`),
    );
    return `${answers.join('\n\n')}\n\nWeigh these views, decide, and write the decision with room_note.`;
  }

  async note(threadId: string, input: { key: string; text: string; scope: 'room' | 'playbook' }): Promise<string> {
    const { found } = await this.leadRoom(threadId);
    const [room, playbook] = this.scopes(found);
    const scope = (input.scope === 'playbook' ? playbook : room) as string;
    if (input.text.trim()) await this.store.remember(scope, input.key, input.text, 'lead');
    else await this.store.forget(scope, input.key);
    const entry: RoomMemoryEntry = {
      scope: input.scope,
      key: input.key,
      text: input.text,
      updatedBy: 'lead',
      updatedAt: Date.now(),
    };
    this.bus.emit(found.room.id, { type: 'memory', entry });
    return input.text.trim() ? `Noted “${input.key}”.` : `Forgot “${input.key}”.`;
  }

  async advance(threadId: string, input: { stage: string; summary: string }): Promise<string> {
    const { found, playbook } = await this.leadRoom(threadId);
    const stages = playbook.config.stages;
    if (!stages.includes(input.stage)) return `The playbook has no stage ${input.stage}. Stages: ${stages.join(', ')}.`;
    if (playbook.config.gates[input.stage] === 'owner') {
      const gated = await this.draft(
        found,
        { kind: 'advance', name: input.stage, summary: input.summary, payload: { stage: input.stage } },
        `Asks you to move the room to “${input.stage}”: ${input.summary}`,
      );
      await this.runs?.step(found.room.id, {
        kind: 'advance',
        name: input.stage,
        detail: input.summary,
        state: 'waiting',
        actionId: gated.id,
      });
      return `The owner decides on moving to ${input.stage}; you are told when they do. Wait for it.`;
    }
    await this.enter(found, input.stage, input.summary, 'lead');
    await this.runs?.step(found.room.id, {
      kind: 'advance',
      name: input.stage,
      detail: input.summary,
      state: 'done',
    });
    return `The room is now at ${input.stage}.`;
  }

  async decide(roomId: string, actionId: string, body: RoomActionDecision): Promise<RoomAction> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    const action = await this.store.action(roomId, actionId);
    if (!action) throw new NotFoundException('No action with this id in the room.');
    if (action.state !== 'pending') throw new ConflictException('This action was decided already.');
    if (body.decision === 'discard')
      return await this.settleAction(
        found,
        action,
        'discarded',
        null,
        `You discarded ${action.name}.`,
        `The owner discarded action ${action.id} (${action.name}: ${action.summary}).`,
      );
    if (action.kind === 'advance') {
      await this.store.decide(roomId, actionId, 'done', null);
      await this.runs?.settleAction(roomId, actionId, 'done', null);
      await this.enter(found, action.name, action.summary, 'coordinator');
      return await this.publish(roomId, actionId);
    }
    if (action.kind === 'playbook') {
      const { ok, result } = await this.editor.apply(found, action);
      return await this.settleAction(
        found,
        action,
        ok ? 'done' : 'failed',
        result,
        ok
          ? `You applied the playbook “${action.name}”. ${result}`
          : `You approved the playbook “${action.name}”, but it was not written: ${result}`,
        ok
          ? `The owner applied your playbook “${action.name}” (action ${action.id}). ${result} The room follows it from now.`
          : `The owner approved your playbook “${action.name}” (action ${action.id}), but it was not written: ${result}`,
      );
    }
    if (found.rehearsal)
      return await this.settleAction(
        found,
        action,
        'done',
        RoomPlaybookService.REHEARSED,
        `You approved ${action.name}; in the rehearsal it did not run.`,
        `The owner approved action ${action.id} (${action.name}). Rehearsal: it did not run, nothing went out. Go on as if it had worked.`,
      );
    const result = await this.tools.run(await this.agents.projectFolder(found), this.tools.callOf(action.payload));
    return await this.settleAction(
      found,
      action,
      result.ok ? 'done' : 'failed',
      this.tools.cut(result.output),
      result.ok
        ? `You approved ${action.name}; it ran.`
        : `You approved ${action.name}, but it failed: ${result.output.slice(0, 500)}`,
      `The owner approved action ${action.id} (${action.name}). ${result.ok ? 'It ran' : 'It failed'}:\n\n${result.output.slice(0, 4000)}`,
    );
  }

  private async settleAction(
    found: FoundRoom,
    action: RoomAction,
    state: 'done' | 'failed' | 'discarded',
    result: string | null,
    note: string,
    nudge: string,
  ): Promise<RoomAction> {
    const roomId = found.room.id;
    await this.store.decide(roomId, action.id, state, result);
    await this.runs?.settleAction(roomId, action.id, state, result);
    await this.bus.record(roomId, { kind: 'note', actor: 'coordinator', text: note });
    void this.lead.nudge(roomId, nudge, { kind: 'approval', title: note });
    return await this.publish(roomId, action.id);
  }

  async tick(now = Date.now()): Promise<void> {
    this.ticking ??= (async () => {
      await Promise.all(
        (await this.rooms.playbookRooms()).map((roomId) =>
          this.fire(roomId, now).catch((error: unknown) =>
            this.logger.warn(
              `Room ${roomId} triggers failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        ),
      );
    })().finally(() => (this.ticking = undefined));
    await this.ticking;
  }

  private async fire(roomId: string, now: number): Promise<void> {
    const found = await this.rooms.get(roomId);
    if (!found || found.paused) return;
    const playbook = await this.of(found).catch(() => undefined);
    if (!playbook) return;
    const runs = await this.store.lastRuns(roomId);
    for (const schedule of playbook.config.on.schedule) {
      const stamp = schedule.cron ? Math.floor(now / 60_000) * 60_000 : now;
      const due = schedule.cron
        ? RoomSchedule.matches(schedule.cron, new Date(now)) && runs.get(schedule.id) !== stamp
        : now - (runs.get(schedule.id) ?? 0) >= RoomSchedule.duration(schedule.every ?? '1h');
      if (!due) continue;
      await this.store.setLastRun(roomId, schedule.id, stamp);
      await this.rooms.setAgentTurns(roomId, 0);
      void this.lead.nudge(roomId, RoomPlaybookService.wake(schedule), {
        kind: 'schedule',
        trigger: schedule.id,
        title: schedule.say || schedule.id,
      });
    }
    for (const trigger of playbook.config.on.poll) {
      if (now - (runs.get(trigger.id) ?? 0) < RoomSchedule.duration(trigger.every)) continue;
      await this.store.setLastRun(roomId, trigger.id, now);
      await this.poll(found, playbook, trigger, now, false).catch((error: unknown) =>
        this.logger.warn(
          `Trigger ${trigger.id} of room ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  /** `dry`: a poll only lists which items are new, a schedule only says what the lead would be told. */
  async fireNow(roomId: string, triggerId: string, dry: boolean, now = Date.now()): Promise<PlaybookFireResult> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    if (!found.playbook) throw new ConflictException('This room follows no playbook.');
    const playbook = this.playbooks.loadOrConflict(
      this.playbooks.place(await this.agents.projectFolder(found), found.room.id),
      found.playbook,
    );
    const schedule = playbook.config.on.schedule.find((candidate) => candidate.id === triggerId);
    if (schedule) {
      const text = RoomPlaybookService.wake(schedule);
      if (dry) return { text: `The lead would be told: ${text}`, items: [] };
      await this.bus.record(roomId, {
        kind: 'note',
        actor: 'coordinator',
        text: `You ran the schedule ${schedule.id} now.`,
      });
      await this.rooms.setAgentTurns(roomId, 0);
      void this.lead.nudge(roomId, text, {
        kind: 'schedule',
        trigger: schedule.id,
        title: schedule.say || schedule.id,
      });
      return { text: `Woke the lead: ${text}`, items: [] };
    }
    const trigger = playbook.config.on.poll.find((candidate) => candidate.id === triggerId);
    if (!trigger) throw new NotFoundException(`The playbook has no trigger ${triggerId}.`);
    if (!dry) await this.store.setLastRun(roomId, trigger.id, now);
    try {
      return await this.poll(found, playbook, trigger, now, dry);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private async poll(
    found: FoundRoom,
    playbook: Playbook,
    trigger: PlaybookPoll,
    now: number,
    dry: boolean,
  ): Promise<PlaybookFireResult> {
    const roomId = found.room.id;
    const call = this.tools.prepare(playbook, trigger.tool, trigger.with, this.context(found));
    const result = await this.tools.run(await this.agents.projectFolder(found), call);
    if (!result.ok) throw new Error(`${trigger.tool} failed: ${result.output.slice(0, 300)}`);
    let items: { key: string; item: unknown }[];
    try {
      items = this.tools.items(result.output, trigger.key);
    } catch {
      throw new Error(`${trigger.tool} did not print JSON.`);
    }
    const keys = items.map((item) => item.key);
    const fresh = new Set(
      dry
        ? await this.store.peekUnseen(roomId, trigger.id, keys)
        : await this.store.unseen(roomId, trigger.id, keys, now),
    );
    const listed = items.slice(0, 50).map((item) => ({ key: item.key, fresh: fresh.has(item.key) }));
    const news = items.filter((item) => fresh.has(item.key)).slice(0, 5);
    if (!news.length) return { text: `Nothing new among ${items.length}; the lead is not woken.`, items: listed };
    if (dry)
      return {
        text: `${fresh.size} new among ${items.length}; the lead would be woken with ${news.length}.`,
        items: listed,
      };
    await this.bus.record(roomId, {
      kind: 'note',
      actor: 'coordinator',
      text: `Trigger ${trigger.id} found ${news.length} new: ${news.map((item) => item.key).join(', ')}.`,
    });
    await this.rooms.setAgentTurns(roomId, 0);
    void this.lead.nudge(
      roomId,
      `Trigger ${trigger.id} found ${news.length} new item${news.length === 1 ? '' : 's'}. ${trigger.say}\n\n${JSON.stringify(
        news.map((item) => item.item),
        null,
        2,
      ).slice(0, 8000)}`,
      {
        kind: 'poll',
        trigger: trigger.id,
        title: `${news.length} new: ${news.map((item) => item.key).join(', ')}`,
      },
    );
    return { text: `Found ${news.length} new; woke the lead.`, items: listed };
  }

  private async ask(found: FoundRoom, playbook: Playbook, role: string, question: string): Promise<string> {
    const participant = playbook.config.participants.find((candidate) => candidate.role === role);
    if (!participant)
      return `The playbook has no participant ${role}. Participants: ${playbook.config.participants.map((p) => p.role).join(', ') || 'none'}.`;
    await this.bus.record(found.room.id, { kind: 'note', actor: 'lead', text: `Asks the ${role}: ${question}`, role });
    const step = await this.runs?.step(found.room.id, { kind: 'consult', name: role, detail: question });
    let answer: { text: string; environmentId: string | null };
    let answered = true;
    try {
      answer = await this.answerOf(found, participant, question);
    } catch (error) {
      answered = false;
      answer = {
        text: `The ${role} could not answer: ${error instanceof Error ? error.message : String(error)}`,
        environmentId: null,
      };
    }
    await this.bus.record(found.room.id, {
      kind: 'message',
      actor: 'consultant',
      text: answer.text.slice(0, 32000),
      role,
      environmentId: answer.environmentId,
    });
    await this.runs?.settle(found.room.id, step, answered ? 'done' : 'failed', answer.text);
    return answer.text;
  }

  private async answerOf(
    found: FoundRoom,
    participant: PlaybookParticipant,
    question: string,
  ): Promise<{ text: string; environmentId: string | null }> {
    const consult = {
      roomId: found.room.id,
      roomTitle: found.room.title,
      repository: found.room.repository,
      role: participant.role,
      instructions: participant.instructions,
      question,
    };
    if (participant.agent.agent) {
      const agent = (await this.outside.list()).find(
        (candidate) => candidate.name === participant.agent.agent || candidate.id === participant.agent.agent,
      );
      if (!agent) throw new Error(`No outside agent named ${participant.agent.agent}.`);
      const reply = await this.outside.sendMessage(
        agent.id,
        this.plainRequest(`${participant.instructions}\n\n${question}`),
      );
      return {
        text: await this.settle(reply, async (id) => await this.outside.getTask(agent.id, { tenant: '', id })),
        environmentId: agent.id,
      };
    }
    if (participant.agent.machine) {
      const manager = await this.peers.manager();
      const peer = manager.peers.find(
        (candidate) =>
          candidate.state === 'active' &&
          (candidate.name === participant.agent.machine || candidate.peerId === participant.agent.machine),
      );
      if (!peer && manager.self.name !== participant.agent.machine)
        throw new Error(`${participant.agent.machine} is not a paired computer.`);
      if (peer) {
        const request = SendMessageRequest.fromJSON({
          message: {
            messageId: randomUUID(),
            contextId: found.room.id,
            role: 'ROLE_USER',
            parts: [{ text: question, mediaType: 'text/plain' }],
            metadata: { [A2A_ROOM_EXTENSION]: { consult: true, base: found.room.baseCommit, ...consult } },
            extensions: [A2A_ROOM_EXTENSION],
          },
          configuration: { acceptedOutputModes: ['text/markdown', 'text/plain'], returnImmediately: true },
        });
        const reply = await this.a2a.sendMessage(peer.peerId, request);
        const relay = this.live.relay({
          roomId: found.room.id,
          actor: 'consultant',
          role: participant.role,
          environmentId: peer.peerId,
        });
        const abort = new AbortController();
        if (!('messageId' in reply))
          void RoomA2a.relay(
            this.a2a.subscribe(peer.peerId, { tenant: '', id: reply.id }, abort.signal),
            'pi-kit',
            relay.put,
          );
        try {
          return {
            text: await this.settle(reply, async (id) => await this.a2a.getTask(peer.peerId, { tenant: '', id })),
            environmentId: peer.peerId,
          };
        } finally {
          abort.abort();
          relay.end();
        }
      }
    }
    return {
      text: await this.consultant.ask({
        ...consult,
        folder: await this.agents.projectFolder(found),
        settings: { model: participant.model, thinking: participant.thinking },
      }),
      environmentId: null,
    };
  }

  private plainRequest(text: string): SendMessageRequest {
    return SendMessageRequest.fromJSON({
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text, mediaType: 'text/plain' }] },
      configuration: { acceptedOutputModes: ['text/markdown', 'text/plain'], returnImmediately: false },
    });
  }

  private async settle(first: Task | Message, read: (id: string) => Promise<Task>): Promise<string> {
    if ('messageId' in first) return RoomA2a.text(first) || '(no answer)';
    const deadline = Date.now() + RoomPlaybookService.CONSULT_LIMIT;
    let task = first;
    while (!this.terminal(task.status?.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      task = await read(task.id);
    }
    if (!this.terminal(task.status?.state)) return 'The consultant took too long; no answer.';
    const artifacts = (task.artifacts ?? [])
      .filter((artifact) => artifact.artifactId !== RoomA2a.LIVE)
      .flatMap((artifact) => artifact.parts.map((part) => (part.content?.$case === 'text' ? part.content.value : '')))
      .filter(Boolean)
      .join('\n\n');
    return artifacts || RoomA2a.text(task.status?.message) || '(no answer)';
  }

  private terminal(state: TaskState | undefined): boolean {
    return state !== undefined && RoomPlaybookService.TERMINAL.has(state);
  }

  private async enter(found: FoundRoom, stage: string, summary: string, actor: 'lead' | 'coordinator'): Promise<void> {
    await this.rooms.setStage(found.room.id, stage);
    await this.bus.record(found.room.id, {
      kind: 'note',
      actor,
      text: `${actor === 'lead' ? 'Moves' : 'You moved'} the room to “${stage}”: ${summary}`,
    });
    this.bus.emit(found.room.id, { type: 'room', mode: found.mode, paused: found.paused, stage });
    if (actor === 'coordinator')
      void this.lead.nudge(found.room.id, `The owner moved the room to the stage “${stage}”. Go on with it.`, {
        kind: 'stage',
        title: stage,
      });
  }

  private async run(found: FoundRoom, call: ToolCall, tool: string, reason: string): Promise<ToolRun> {
    const result = await this.tools.run(await this.agents.projectFolder(found), call);
    await this.bus.record(found.room.id, {
      kind: 'note',
      actor: 'coordinator',
      text: `${result.ok ? 'Ran' : 'Failed to run'} ${tool} for the lead: ${reason}`,
    });
    return result;
  }

  private static wake(schedule: { id: string; say?: string }): string {
    return `Schedule ${schedule.id}: ${schedule.say || 'it is time for the next round.'}`;
  }

  private reply(result: ToolRun, text: string): string {
    return result.ok ? text || '(no output)' : `The call failed: ${this.tools.cut(result.output)}`;
  }

  private async draft(
    found: FoundRoom,
    action: Pick<RoomAction, 'kind' | 'name' | 'summary' | 'payload'>,
    note: string,
  ): Promise<RoomAction> {
    const inserted = await this.store.insertAction({ ...action, id: randomUUID(), roomId: found.room.id });
    await this.bus.record(found.room.id, { kind: 'note', actor: 'lead', text: note });
    this.bus.emit(found.room.id, { type: 'action', action: inserted });
    return inserted;
  }

  private async publish(roomId: string, actionId: string): Promise<RoomAction> {
    const action = (await this.store.action(roomId, actionId)) as RoomAction;
    this.bus.emit(roomId, { type: 'action', action });
    return action;
  }

  private context(found: FoundRoom): Record<string, string> {
    return { repository: found.room.repository, room: found.room.id };
  }

  private async leadRoom(threadId: string): Promise<{ found: FoundRoom; playbook: Playbook }> {
    const roomId = await this.rooms.roomOfLead(threadId);
    const found = roomId ? await this.rooms.get(roomId) : undefined;
    if (!found) throw new Error('This session is not the lead of a room.');
    const playbook = await this.of(found);
    if (!playbook) throw new Error('This room follows no playbook.');
    return { found, playbook };
  }
}
