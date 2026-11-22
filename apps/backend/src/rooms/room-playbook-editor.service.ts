import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import {
  PlaybookProposalSchema,
  type PlaybookCheck,
  type PlaybookDetail,
  type PlaybookProposal,
  type PlaybookTry,
  type PlaybookTryResult,
  type RoomAction,
  type PlaybookAgentSettings,
} from '@pi-kit/protocol';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { type FoundRoom, RoomsRepository } from '../db/rooms.repository';
import { McpCallService } from '../mcp/mcp-call.service';
import { RoomAgents } from './room-agents';
import { RoomBus } from './room-bus';
import { RoomEnvironments } from './room-environments';
import { NO_ROOM, RoomLeadService } from './room-lead.service';
import { RoomPlaybookFiles, type Playbook, type PlaybookSource } from './room-playbook-files.service';
import { RoomPlaybookTools } from './room-playbook-tools.service';
import { RoomSchedule } from './room-schedule';

/** Shows a room's playbook, checks and tries it, and writes the changes the lead proposes once the owner applies them. */
@Injectable()
export class RoomPlaybookEditor {
  private static readonly TRY_LIMIT = 16 * 1024;

  constructor(
    private readonly rooms: RoomsRepository,
    private readonly store: RoomPlaybooksRepository,
    private readonly files: RoomPlaybookFiles,
    private readonly tools: RoomPlaybookTools,
    private readonly bus: RoomBus,
    private readonly lead: RoomLeadService,
    private readonly agents: RoomAgents,
    private readonly environments: RoomEnvironments,
    private readonly mcp: McpCallService,
  ) {}

  async detail(roomId: string, now = Date.now()): Promise<PlaybookDetail> {
    const found = await this.room(roomId);
    if (!found.playbook) throw new NotFoundException('This room follows no playbook.');
    const place = this.files.place(await this.agents.projectFolder(found), roomId);
    const { dir, source } = this.files.locate(place, found.playbook);
    if (!source) throw new NotFoundException(`No playbook named ${found.playbook} in ${place.project}.`);
    const read = this.files.validate(join(dir, RoomPlaybookFiles.SKILL), found.playbook, source);
    const config = 'config' in read ? read.config : null;
    const runs = await this.store.lastRuns(roomId);
    const last = (id: string) => runs.get(id) ?? null;
    const usage: Record<string, number> = {};
    for (const name of Object.keys(config?.['safe-outputs'] ?? {}))
      usage[name] = await this.store.countActions(roomId, name, now - 86_400_000);
    return {
      name: read.name,
      description: read.description,
      folder: this.files.shown(place, dir),
      origin: this.files.origin(place, dir),
      skill: source.skill,
      yaml: source.yaml,
      config,
      error: 'error' in read ? read.error : null,
      stage: found.stage ?? config?.stages[0] ?? null,
      triggers: [
        ...(config?.on.schedule ?? []).map((schedule) => ({
          id: schedule.id,
          kind: 'schedule' as const,
          every: schedule.every ?? null,
          cron: schedule.cron ?? null,
          tool: null,
          say: schedule.say,
          lastRun: last(schedule.id),
          nextRun: schedule.cron
            ? (RoomSchedule.next(schedule.cron, now) ?? null)
            : (last(schedule.id) ?? now) + RoomSchedule.duration(schedule.every ?? '1h'),
        })),
        ...(config?.on.poll ?? []).map((poll) => ({
          id: poll.id,
          kind: 'poll' as const,
          every: poll.every,
          cron: null,
          tool: poll.tool,
          say: poll.say,
          lastRun: last(poll.id),
          nextRun: (last(poll.id) ?? now) + RoomSchedule.duration(poll.every),
        })),
      ],
      usage,
      checks:
        'config' in read
          ? await this.check(place.project, read, found.leadThreadId)
          : [{ level: 'error', subject: 'playbook', message: read.error }],
    };
  }

  private async check(folder: string, playbook: Playbook, leadThreadId: string | null): Promise<PlaybookCheck[]> {
    const { config } = playbook;
    const checks: PlaybookCheck[] = [];
    const connectors = [...Object.entries(config.tools), ...Object.entries(config['safe-outputs'])];
    for (const server of new Set(connectors.flatMap(([, tool]) => (tool.mcp ? [tool.mcp.server] : [])))) {
      const problem = await this.mcp.problem(server);
      checks.push({ level: problem ? 'error' : 'ok', subject: `mcp ${server}`, message: problem ?? 'Ready.' });
    }
    for (const command of new Set(connectors.flatMap(([, tool]) => (tool.run?.[0] ? [tool.run[0]] : [])))) {
      if (/\{[a-zA-Z_]/.test(command))
        checks.push({ level: 'warn', subject: `command ${command}`, message: 'The command is a parameter.' });
      else
        checks.push(
          this.found(folder, command)
            ? { level: 'ok', subject: `command ${command}`, message: 'Found.' }
            : { level: 'error', subject: `command ${command}`, message: `${command} is not on the PATH.` },
        );
    }
    if (process.platform !== 'darwin')
      for (const [name, tool] of connectors)
        if (tool.mail || (tool.calendar && !tool.calendar.ics))
          checks.push({ level: 'error', subject: `tool ${name}`, message: 'It reads Mail or Calendar of a Mac.' });
    const asked: [string, PlaybookAgentSettings | undefined][] = [
      ['lead', config.lead],
      ['workers', config.workers],
      ...config.participants.map((participant): [string, PlaybookAgentSettings] => [
        `participant ${participant.role}`,
        participant,
      ]),
    ];
    const models = asked.some(([, settings]) => settings?.model) ? await this.agents.models(leadThreadId) : undefined;
    for (const [subject, settings] of asked) {
      if (!settings?.model) continue;
      const model = models?.find((candidate) => `${candidate.provider}/${candidate.id}` === settings.model);
      if (!models)
        checks.push({
          level: 'warn',
          subject: `model ${subject}`,
          message: `${settings.model} is checked once the lead runs.`,
        });
      else if (!model)
        checks.push({
          level: 'error',
          subject: `model ${subject}`,
          message: `${settings.model} is not available here; it would run on the default model.`,
        });
      else if (settings.thinking && settings.thinking !== 'off' && !model.reasoning)
        checks.push({
          level: 'warn',
          subject: `model ${subject}`,
          message: `${settings.model} does not think; the effort ${settings.thinking} is ignored.`,
        });
      else checks.push({ level: 'ok', subject: `model ${subject}`, message: 'Available.' });
    }
    const remote = config.participants.filter((participant) => participant.agent.machine || participant.agent.agent);
    const environments = remote.length
      ? await this.environments.list({ agents: remote.some((participant) => participant.agent.agent) })
      : [];
    for (const participant of remote) {
      const target = participant.agent.machine ?? participant.agent.agent ?? '';
      const environment = environments.find(
        (candidate) => candidate.name === target || candidate.environmentId === target,
      );
      checks.push(
        !environment
          ? {
              level: 'error',
              subject: `participant ${participant.role}`,
              message: participant.agent.agent
                ? `No outside agent named ${target}.`
                : `${target} is not a paired computer.`,
            }
          : environment.ready
            ? { level: 'ok', subject: `participant ${participant.role}`, message: `${environment.name} answers.` }
            : {
                level: 'warn',
                subject: `participant ${participant.role}`,
                message: environment.reason ?? `${target} cannot answer now.`,
              },
      );
    }
    for (const schedule of config.on.schedule)
      if (schedule.cron && RoomSchedule.next(schedule.cron, Date.now()) === undefined)
        checks.push({ level: 'warn', subject: `trigger ${schedule.id}`, message: 'It does not run within a month.' });
    for (const poll of config.on.poll) {
      const missing = this.tools.needs(playbook, poll.tool).filter((key) => !(key in poll.with));
      checks.push(
        missing.length
          ? {
              level: 'error',
              subject: `trigger ${poll.id}`,
              message: `${poll.tool} needs ${missing.join(', ')} under with.`,
            }
          : { level: 'ok', subject: `trigger ${poll.id}`, message: `Runs ${poll.tool} every ${poll.every}.` },
      );
    }
    for (const stage of Object.keys(config.gates))
      if (!config.stages.includes(stage))
        checks.push({ level: 'warn', subject: `gate ${stage}`, message: 'No stage has this name.' });
    return checks;
  }

  async try(roomId: string, input: PlaybookTry): Promise<PlaybookTryResult> {
    const found = await this.room(roomId);
    const folder = await this.agents.projectFolder(found);
    const playbook = this.files.loadOrConflict(this.files.place(folder, roomId), found.playbook ?? '');
    let call;
    try {
      call = this.tools.prepare(playbook, input.tool, input.params, {
        repository: found.room.repository,
        room: found.room.id,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const shown = this.tools.describe(call);
    if (this.tools.output(playbook, input.tool)) return { ran: false, ok: true, call: shown, output: '' };
    const result = await this.tools.run(folder, call);
    return {
      ran: true,
      ok: result.ok,
      call: shown,
      output: this.tools.cut(result.output, RoomPlaybookEditor.TRY_LIMIT),
    };
  }

  /** The lead's `room_playbook_propose`: valid files become an action with their diff; invalid ones go back to the lead. */
  async propose(
    threadId: string,
    input: { name: string; skill: string; yaml: string; summary: string },
  ): Promise<string> {
    const roomId = await this.rooms.roomOfLead(threadId);
    const found = roomId ? await this.rooms.get(roomId) : undefined;
    if (!found) throw new Error('This session is not the lead of a room.');
    const folder = await this.agents.projectFolder(found);
    const place = this.files.place(folder, found.room.id);
    const { dir, source: before } = this.files.locate(place, input.name);
    const proposed = { skill: input.skill, yaml: input.yaml };
    const read = this.files.validate(join(dir, RoomPlaybookFiles.SKILL), input.name, proposed);
    if ('error' in read)
      return `Nothing was proposed: the playbook is not valid. ${read.error}\n\nFix it and propose again.`;
    if (before?.skill === input.skill && before.yaml === input.yaml)
      return 'Those are the files as they are now; there is nothing to propose.';
    const checks = await this.check(folder, read, found.leadThreadId);
    const where = this.files.shown(place, dir);
    const payload: PlaybookProposal = {
      name: input.name,
      folder: where,
      create: !before,
      ...proposed,
      base: RoomPlaybookEditor.digest(before),
      files: [
        [RoomPlaybookFiles.SKILL, before?.skill, input.skill],
        [RoomPlaybookFiles.CONFIG, before?.yaml, input.yaml],
      ]
        .filter(([, old, next]) => old !== next)
        .map(([file, old, next]) => {
          const path = join(where, file as string);
          return {
            path,
            written: old === undefined,
            hunks: structuredPatch(path, path, old ?? '', next ?? '', '', '', { context: 3 }).hunks.map((hunk) => ({
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
              lines: hunk.lines,
            })),
          };
        }),
      checks,
    };
    const action = await this.store.insertAction({
      id: randomUUID(),
      roomId: found.room.id,
      kind: 'playbook',
      name: input.name,
      summary: input.summary,
      payload: { ...payload },
    });
    await this.bus.record(found.room.id, {
      kind: 'note',
      actor: 'lead',
      text: `${before ? 'Proposes changes to' : 'Proposes'} the playbook “${input.name}”: ${input.summary}`,
    });
    this.bus.emit(found.room.id, { type: 'action', action });
    const problems = checks.filter((check) => check.level !== 'ok');
    return [
      `Proposed as action ${action.id}. Nothing is written yet: the owner reviews the diff and applies or discards it, and you are told.`,
      problems.length
        ? `The check found:\n${problems.map((check) => `- ${check.level} ${check.subject}: ${check.message}`).join('\n')}`
        : 'The check found nothing wrong.',
    ].join('\n\n');
  }

  /** Writes an approved proposal into the room's project folder; the room follows it from the lead's next turn. */
  async apply(found: FoundRoom, action: RoomAction): Promise<{ ok: boolean; result: string }> {
    const parsed = PlaybookProposalSchema.safeParse(action.payload);
    if (!parsed.success) return { ok: false, result: 'The proposal is not readable.' };
    const proposal = parsed.data;
    const place = this.files.place(await this.agents.projectFolder(found), found.room.id);
    const { dir, source } = this.files.locate(place, proposal.name);
    if (RoomPlaybookEditor.digest(source) !== proposal.base)
      return {
        ok: false,
        result: 'The playbook’s files changed since the lead proposed this. Ask it to propose again.',
      };
    if (this.files.shown(place, dir) !== proposal.folder)
      return { ok: false, result: 'The proposal points outside the playbook’s folder.' };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RoomPlaybookFiles.SKILL), proposal.skill, 'utf8');
    await writeFile(join(dir, RoomPlaybookFiles.CONFIG), proposal.yaml, 'utf8');
    const written = `Wrote ${join(proposal.folder, RoomPlaybookFiles.SKILL)} and ${RoomPlaybookFiles.CONFIG}; ${this.files.origin(place, dir) === 'room' ? `they are in the room's folder ${place.room}` : `they are uncommitted changes in ${place.project}`}.`;
    if (!found.playbook) {
      const failed = await this.lead.update(found.room.id, { playbook: proposal.name }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      return {
        ok: true,
        result: failed ? `${written} It was not attached (${failed}); attach it from the room's header.` : written,
      };
    }
    if (found.playbook === proposal.name) {
      this.lead.rebriefNext(found.room.id);
      this.bus.emit(found.room.id, {
        type: 'room',
        mode: found.mode,
        paused: found.paused,
        rehearsal: found.rehearsal,
        stage: found.stage,
        playbook: found.playbook,
      });
    }
    return { ok: true, result: written };
  }

  private static digest(source: PlaybookSource | undefined): string {
    return source ? createHash('sha256').update(source.skill).update('\0').update(source.yaml).digest('hex') : 'none';
  }

  private found(folder: string, command: string): boolean {
    if (command.includes('/') || command.includes('\\')) return existsSync(resolve(folder, command));
    const endings = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    return (process.env['PATH'] ?? '')
      .split(delimiter)
      .filter(Boolean)
      .some((dir) => endings.some((ending) => existsSync(join(dir, command + ending))));
  }

  private async room(roomId: string): Promise<FoundRoom> {
    const found = await this.rooms.get(roomId);
    if (!found) throw new NotFoundException(NO_ROOM);
    return found;
  }
}
