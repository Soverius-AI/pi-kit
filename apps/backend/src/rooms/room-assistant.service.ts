import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  RoomAssistantCommandSchema,
  RoomCommitmentInputSchema,
  type RoomAssistantCommand,
  type RoomAssistantPolicy,
  type RoomAssistantStatus,
  type RoomCommitmentInput,
  type ChangeRoomCommitment,
  type RoomFactInput,
  type RoomFolderInput,
} from '@pi-kit/protocol';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomsRepository, type FoundRoom } from '../db/rooms.repository';
import { RoomLeadService } from './room-lead.service';
import { RoomWorkspace } from './room-workspace.service';
import { RoomTime } from './room-time';
import { RoomBus } from './room-bus';

@Injectable()
export class RoomAssistant implements OnModuleInit, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private stopping = false;
  constructor(
    private readonly store: RoomAssistantRepository,
    private readonly notes: RoomPlaybooksRepository,
    private readonly rooms: RoomsRepository,
    private readonly lead: RoomLeadService,
    private readonly workspace: RoomWorkspace,
    private readonly bus: RoomBus,
  ) {}
  onModuleInit(): void {
    this.lead.setAssistant(this);
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 10000);
    this.timer.unref();
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
  }
  async status(roomId: string): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    await this.workspace.ensureProject(roomId);
    return {
      policy: await this.store.policy(roomId),
      memory: (await this.notes.memory([`room:${roomId}`])).map(({ key, text, updatedBy, updatedAt }) => ({
        key,
        text,
        updatedBy,
        updatedAt,
      })),
      commitments: await this.store.commitments(roomId),
      folders: await this.workspace.list(roomId),
      workspace: this.workspace.path(roomId),
      work: await this.store.work(roomId),
      files: await this.workspace.files(roomId),
    };
  }
  async file(roomId: string, path: string) {
    await this.lead.found(roomId);
    return this.workspace.file(roomId, path);
  }
  async policy(roomId: string, policy: RoomAssistantPolicy): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    await this.store.setPolicy(roomId, policy);
    return this.status(roomId);
  }
  async remember(roomId: string, input: RoomFactInput, by = 'owner'): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    if (input.text.trim()) await this.notes.remember(`room:${roomId}`, input.key, input.text, by);
    else await this.notes.forget(`room:${roomId}`, input.key);
    this.bus.emit(roomId, {
      type: 'memory',
      entry: { scope: 'room', key: input.key, text: input.text, updatedBy: by, updatedAt: Date.now() },
    });
    return this.status(roomId);
  }
  async create(roomId: string, input: RoomCommitmentInput) {
    await this.lead.found(roomId);
    return this.store.create(roomId, input);
  }
  async change(roomId: string, id: string, body: ChangeRoomCommitment): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    await this.rooms.inTransaction(async () => {
      if (!(await this.store.change(roomId, id, body)))
        throw new NotFoundException('No commitment with this id in this room.');
      await this.store.invalidateCommitment(roomId, id);
    });
    return this.status(roomId);
  }
  async addFolder(roomId: string, input: RoomFolderInput): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    if (this.lead.state(roomId) === 'working')
      throw new ConflictException('Wait for the lead to finish before changing folder access.');
    await this.workspace.add(roomId, input);
    this.lead.rebriefNext(roomId);
    return this.status(roomId);
  }
  async removeFolder(roomId: string, id: string): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    if (this.lead.state(roomId) === 'working')
      throw new ConflictException('Wait for the lead to finish before changing folder access.');
    await this.workspace.remove(roomId, id);
    this.lead.rebriefNext(roomId);
    return this.status(roomId);
  }
  async work(roomId: string, id: string, retry: boolean): Promise<RoomAssistantStatus> {
    await this.lead.found(roomId);
    if (retry) {
      if (!(await this.store.retry(roomId, id)))
        throw new ConflictException('Only failed or interrupted work can be retried.');
      await this.lead.resumePending();
    } else await this.store.dismiss(roomId, id);
    return this.status(roomId);
  }
  async prepare(found: FoundRoom, threadId: string): Promise<string> {
    return this.workspace.prepare(found.room.id, threadId);
  }
  enabled(): Promise<boolean> {
    return this.store.roomsEnabled();
  }
  async canWake(found: FoundRoom): Promise<boolean> {
    if (!(await this.enabled())) return false;
    const policy = await this.store.policy(found.room.id);
    if (!policy.enabled) return false;
    const today = RoomTime.day(Date.now(), policy.timezone);
    return (
      (await this.store.startedRuns(found.room.id, Date.now() - 48 * 3600000)).filter(
        (at) => RoomTime.day(at, policy.timezone) === today,
      ).length < (policy.dailyRunLimit ?? 20)
    );
  }
  async briefing(found: FoundRoom): Promise<string> {
    const status = await this.status(found.room.id);
    return [
      `Your stable room working directory is ${status.workspace}. Keep it as your base.`,
      'Use room_assistant for status, remember/forget, commitments, completion/snooze, searching linked folders, and writing generated files to outputs. You may write generated room outputs with that tool; other host files remain read-only. Never claim to remember, schedule or save unless the tool confirms it.',
      'Schedule only work the owner requested. Proactive execution is ' +
        (status.policy.enabled ? 'enabled' : 'disabled; explain that saved reminders wait until the owner enables it') +
        `. Room timezone: ${status.policy.timezone}. Current time: ${new Date().toISOString()}.`,
      status.memory.length
        ? `Remembered facts (owner can correct or forget):\n${status.memory
            .slice(-40)
            .map((row) => `${row.key}: ${row.text} [${row.updatedBy}, ${new Date(row.updatedAt).toISOString()}]`)
            .join('\n')
            .slice(0, 12000)}`
        : '',
      `Open commitments:\n${
        status.commitments
          .filter((row) => row.state === 'open')
          .map(
            (row) =>
              `${row.id}: ${row.title}; due ${new Date(row.dueAt).toISOString()} (${row.timezone}); ${row.details}`,
          )
          .join('\n') || 'None.'
      }`,
      `Linked reference folders:\n${status.folders.map((row) => `folders/${row.alias}: ${row.available ? 'read-only' : row.reason}`).join('\n') || 'None.'}`,
      'Keep notifications useful: report new findings or ask for a specific decision. Internal scheduled checks that find no meaningful change should return exactly [NO_UPDATE]. Do not repeat reminders after the owner completed or snoozed them.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  async command(threadId: string, input: RoomAssistantCommand): Promise<string> {
    input = RoomAssistantCommandSchema.parse(input);
    const roomId = await this.rooms.roomOfLead(threadId);
    if (!roomId) throw new BadRequestException('Only a room lead can manage its assistant state.');
    if (input.action === 'status') {
      const status = await this.status(roomId);
      if (input.query) {
        const query = input.query.toLowerCase();
        status.memory = status.memory.filter((row) => `${row.key} ${row.text}`.toLowerCase().includes(query));
      }
      return JSON.stringify(status);
    }
    if (input.action === 'remember' || input.action === 'forget') {
      if (!input.key) throw new BadRequestException('A memory key is required.');
      await this.remember(
        roomId,
        { key: input.key, text: input.action === 'forget' ? '' : required(input.text, 'text') },
        'lead',
      );
      return input.action === 'forget' ? `Forgot ${input.key}.` : `Remembered ${input.key}.`;
    }
    if (input.action === 'commitment') {
      const policy = await this.store.policy(roomId);
      const daily = input.dailyAt ?? null;
      const item = await this.create(
        roomId,
        RoomCommitmentInputSchema.parse({
          title: required(input.title, 'title'),
          details: input.text ?? '',
          dueAt:
            input.dueAt ??
            (daily ? RoomTime.nextDaily(daily, input.timezone ?? policy.timezone, Date.now()) : undefined),
          timezone: input.timezone ?? policy.timezone,
          dailyAt: daily,
          source: 'owner request in room conversation',
        }),
      );
      return `Saved commitment ${item.id}, due ${new Date(item.dueAt).toISOString()} (${item.timezone}). Proactivity is ${policy.enabled ? 'enabled' : 'disabled; it waits for the owner to enable it'}.`;
    }
    if (input.action === 'complete' || input.action === 'cancel' || input.action === 'snooze') {
      if (!input.id) throw new BadRequestException('Use the commitment id from status.');
      if (input.action === 'snooze' && input.dueAt === undefined)
        throw new BadRequestException('A snooze dueAt timestamp is required.');
      await this.change(
        roomId,
        input.id,
        input.action === 'snooze'
          ? { state: 'open', dueAt: input.dueAt }
          : { state: input.action === 'complete' ? 'done' : 'cancelled' },
      );
      return `Commitment ${input.id} updated.`;
    }
    if (input.action === 'output')
      return `Saved ${await this.workspace.output(roomId, required(input.path, 'path'), required(input.text, 'text'))}.`;
    return this.workspace.search(roomId, required(input.query, 'query'));
  }
  tick(now = Date.now()): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.ticking ??= this.fire(now).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async fire(now: number): Promise<void> {
    if (!(await this.enabled())) return;
    for (const { roomId, item } of await this.store.due(now)) {
      const policy = await this.store.policy(roomId);
      if (!policy.enabled) continue;
      await this.rooms.inTransaction(async () => {
        const current = await this.store.commitment(roomId, item.id);
        const found = await this.rooms.get(roomId);
        if (
          !current ||
          !found ||
          found.paused ||
          current.item.state !== 'open' ||
          current.item.dueAt > now ||
          (current.item.lastFiredAt !== null && current.item.lastFiredAt >= current.item.dueAt) ||
          !(await this.store.policy(roomId)).enabled
        )
          return;
        const due = current.item;
        await this.rooms.enqueueWake(
          roomId,
          `Commitment ${due.id} is due: ${due.title}. ${due.details}\nCheck current sources, use memory, and give a concise useful update.`,
          { kind: 'schedule', trigger: due.id, title: `[${due.id}] ${due.title}` },
          `commitment:${due.id}:${current.revision}:${due.dueAt}`,
          [],
          null,
          current.revision,
        );
        await this.store.fired(due.id, now, due.dailyAt ? RoomTime.nextDaily(due.dailyAt, due.timezone, now) : null);
      });
    }
    await this.lead.resumePending();
  }
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new BadRequestException(`${name} is required.`);
  return value;
}
