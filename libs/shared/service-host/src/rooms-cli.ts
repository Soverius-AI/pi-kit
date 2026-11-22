import { resolve } from 'node:path';
import {
  appSettingsSetSetting,
  appSettingsSettings,
  type Room,
  type RoomDetail,
  type RoomRun,
  type RoomStreamLine,
  type RoomTaskQuestion,
  roomsAnswer,
  roomsAnswerLead,
  roomsApprove,
  roomsArchive,
  roomsCreate,
  roomsDecide,
  roomsDecline,
  roomsDetail,
  roomsFireTrigger,
  roomsHosted,
  roomsIntegrate,
  roomsListRuns,
  roomsPlaybookDetail,
  roomsPlaybooks,
  roomsPost,
  roomsStop,
  roomsUpdate,
} from '@pi-kit/api/generated';
import type { BackendEndpoint } from './backend';
import { callHost } from './cli-host';
import type { CliContext, CliIo } from './service-cli';

type Call = { baseUrl: string; auth: string; throwOnError: true };

export class RoomsCli {
  static readonly USAGE = `Room commands (include "rooms" before the command):
  pi-kit rooms                               Whether rooms are on, and the rooms here with what waits for you
  pi-kit rooms on | off                      Turn rooms on or off on this computer
  pi-kit rooms start <folder> --title <t>    Start a room in a git repository here (--playbook <name>, --summary <text>)
  pi-kit rooms show <room>                   Its playbook, stage and triggers, what waits for you and its last runs
  pi-kit rooms runs <room> [<number>]        Its runs, or one run with every step and its output
  pi-kit rooms say <room> <text>             Message the lead (--post only posts, without prompting it)
  pi-kit rooms approve <room> <id>           Approve a draft, a stage, a playbook change or a task; integrate a result
  pi-kit rooms discard <room> <id>           Discard it; a proposed task is declined, a running one stopped
  pi-kit rooms answer <room> <id> <answer>   Answer what the lead or a worker asks: yes, no, or the text
  pi-kit rooms fire <room> <trigger>         Run a playbook trigger now (--dry only shows what it would bring)
  pi-kit rooms pause | resume <room>         Stop or resume everything that wakes the lead
  pi-kit rooms playbook <room> <name|none>   Attach, switch or remove the playbook
  pi-kit rooms rename <room> <title>         Rename it
  pi-kit rooms watch <room>                  Follow the room until Ctrl+C
  pi-kit rooms archive <room>                Archive it (--stop also stops its running tasks)
                                             <room> is its id, the start of its id, or its title; --json on the
                                             list, show and runs prints JSON for scripts
`;

  static readonly run = (args: string[], io: CliIo, ctx: CliContext): Promise<number> =>
    new RoomsCli(io, ctx).run(args);

  private static readonly SETTING = 'collaboration.rooms';
  private static readonly VALUED = ['--title', '--summary', '--playbook'];
  private static readonly SWITCHES = ['--json', '--post', '--dry', '--stop'];
  private static readonly NEEDS_ROOM = [
    'show',
    'runs',
    'say',
    'approve',
    'discard',
    'answer',
    'fire',
    'pause',
    'resume',
    'playbook',
    'rename',
    'watch',
    'archive',
  ];
  private static readonly OUTPUT_LINES = 40;

  private readonly options = new Map<string, string>();
  private readonly switches = new Set<string>();
  private readonly words: string[] = [];
  private call: Call = { baseUrl: '', auth: '', throwOnError: true };

  private constructor(
    private readonly io: CliIo,
    private readonly ctx: CliContext,
  ) {}

  private async run(args: string[]): Promise<number> {
    const problem = this.parse(args);
    const [command = 'list', target, ...rest] = this.words;
    const known = ['list', 'on', 'off', 'start', ...RoomsCli.NEEDS_ROOM].includes(command);
    if (problem || !known || ((command === 'start' || RoomsCli.NEEDS_ROOM.includes(command)) && !target)) {
      this.io.err(
        `${problem ? `pi-kit: ${problem}\n\n` : known ? '' : `pi-kit: unknown command "rooms ${command}".\n\n`}${RoomsCli.USAGE}`,
      );
      return 2;
    }
    const { url, token } = await callHost<BackendEndpoint>(this.ctx, 'backend');
    this.call = { baseUrl: url, auth: token, throwOnError: true };
    if (command === 'on' || command === 'off') return await this.turn(command === 'on');
    if (command === 'list') return await this.list();
    if (command === 'start') return await this.start(target ?? '');
    const room = await this.find(target ?? '');
    if (!room) return 1;
    const path = { roomId: room.id };
    const text = rest.join(' ').trim();
    switch (command) {
      case 'show':
        return await this.show(room);
      case 'runs':
        return await this.runs(room, rest[0]);
      case 'say':
        if (!text) return this.usage('say what?');
        await roomsPost({ ...this.call, path, body: { text, route: this.switches.has('--post') ? 'none' : 'lead' } });
        this.io.out(
          this.switches.has('--post')
            ? 'Posted.\n'
            : `The lead is on it. Follow it with "pi-kit rooms watch ${RoomsCli.short(room.id)}".\n`,
        );
        return 0;
      case 'approve':
      case 'discard':
        return rest[0] ? await this.decide(room, rest[0], command === 'approve') : this.usage('which id?');
      case 'answer':
        return rest[0] && rest.length > 1
          ? await this.answer(room, rest[0], rest.slice(1).join(' '))
          : this.usage('which question, and what is the answer?');
      case 'fire': {
        if (!rest[0]) return this.usage('which trigger?');
        const dry = this.switches.has('--dry');
        const fired = (await roomsFireTrigger({ ...this.call, path: { ...path, triggerId: rest[0] }, body: { dry } }))
          .data;
        this.io.out(`${fired.text}\n`);
        for (const item of fired.items) this.io.out(`  ${item.fresh ? 'new ' : 'seen'}  ${item.key}\n`);
        return 0;
      }
      case 'pause':
      case 'resume':
        await roomsUpdate({ ...this.call, path, body: { paused: command === 'pause' } });
        this.io.out(command === 'pause' ? 'Paused: nothing wakes the lead until you resume.\n' : 'Resumed.\n');
        return 0;
      case 'playbook': {
        if (!rest[0]) return this.usage('which playbook, or none?');
        const playbook = rest[0] === 'none' ? null : rest[0];
        const detail = (await roomsUpdate({ ...this.call, path, body: { playbook } })).data;
        this.io.out(
          detail.playbook
            ? `The room follows ${detail.playbook}${detail.stage ? `, at the stage ${detail.stage}` : ''}.\n`
            : 'The room follows no playbook.\n',
        );
        return 0;
      }
      case 'rename':
        if (!text) return this.usage('rename it to what?');
        this.io.out(
          `Renamed to ${(await roomsUpdate({ ...this.call, path, body: { title: text } })).data.room.title}.\n`,
        );
        return 0;
      case 'watch':
        return await this.watch(room);
      default:
        await roomsArchive({ ...this.call, path, body: { stopTasks: this.switches.has('--stop') } });
        this.io.out(`Archived ${room.title}. Its folder, worktrees and sessions are kept.\n`);
        return 0;
    }
  }

  private parse(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? '';
      if (RoomsCli.VALUED.includes(arg)) {
        const value = args[++i];
        if (value === undefined) return `${arg} needs a value.`;
        this.options.set(arg, value);
      } else if (RoomsCli.SWITCHES.includes(arg)) this.switches.add(arg);
      else if (arg.startsWith('--')) return `unexpected ${arg}.`;
      else this.words.push(arg);
    }
    return undefined;
  }

  private usage(problem: string): number {
    this.io.err(`pi-kit: ${problem}\n\n${RoomsCli.USAGE}`);
    return 2;
  }

  private async turn(on: boolean): Promise<number> {
    await appSettingsSetSetting({ ...this.call, path: { key: RoomsCli.SETTING }, body: { value: on } });
    this.io.out(
      on
        ? 'Rooms are on. Start one with "pi-kit rooms start <folder> --title <title>".\n'
        : 'Rooms are off: their triggers stop and their routes answer 404. Nothing is deleted.\n',
    );
    return 0;
  }

  private async enabled(): Promise<boolean> {
    const settings = (await appSettingsSettings(this.call)).data as Record<string, unknown>;
    return settings[RoomsCli.SETTING] === true;
  }

  private async list(): Promise<number> {
    if (!(await this.enabled())) {
      if (this.switches.has('--json')) this.io.out(`${JSON.stringify({ enabled: false, rooms: [] })}\n`);
      else this.io.out('Rooms are off here. Turn them on with "pi-kit rooms on".\n');
      return 0;
    }
    const rooms = (await roomsHosted(this.call)).data;
    if (this.switches.has('--json')) {
      this.io.out(`${JSON.stringify({ enabled: true, rooms })}\n`);
      return 0;
    }
    if (!rooms.length)
      this.io.out('No rooms here yet. Start one with "pi-kit rooms start <folder> --title <title>".\n');
    for (const room of rooms)
      this.io.out(
        `${RoomsCli.short(room.id)}  ${room.title}  (${room.repository})${room.waiting ? `  ${room.waiting} waiting for you` : ''}\n`,
      );
    return 0;
  }

  private async start(folder: string): Promise<number> {
    const title = this.options.get('--title')?.trim();
    if (!title) return this.usage('a room needs --title.');
    const playbook = this.options.get('--playbook');
    const room = (
      await roomsCreate({
        ...this.call,
        body: {
          projectFolder: resolve(folder),
          title,
          summary: this.options.get('--summary') ?? '',
          ...(playbook ? { playbook } : {}),
        },
      })
    ).data;
    const id = RoomsCli.short(room.id);
    this.io.out(
      `Started "${room.title}" (${id}) for ${room.repository}${playbook ? `, following ${playbook}` : ''}.\n` +
        `Message its lead with: pi-kit rooms say ${id} "<text>"\n`,
    );
    return 0;
  }

  private async find(target: string): Promise<Room | undefined> {
    const rooms = (await roomsHosted(this.call)).data;
    const wanted = target.toLowerCase();
    const exact = rooms.filter((room) => room.id === wanted);
    const matches = exact.length
      ? exact
      : rooms.filter((room) => room.id.startsWith(wanted) || room.title.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    this.io.err(
      matches.length
        ? `pi-kit: several rooms match "${target}": ${matches.map((room) => `${RoomsCli.short(room.id)} ${room.title}`).join(', ')}.\n`
        : `pi-kit: no room "${target}" here. "pi-kit rooms" lists them.\n`,
    );
    return undefined;
  }

  private async show(room: Room): Promise<number> {
    const path = { roomId: room.id };
    const detail = (await roomsDetail({ ...this.call, path })).data;
    const playbook = detail.playbook
      ? (await roomsPlaybookDetail({ ...this.call, path }).catch(() => undefined))?.data
      : undefined;
    const runs = (await roomsListRuns({ ...this.call, path })).data;
    if (this.switches.has('--json')) {
      const { events: _events, ...rest } = detail;
      this.io.out(
        `${JSON.stringify({ ...rest, waiting: this.waiting(detail), triggers: playbook?.triggers ?? [], runs })}\n`,
      );
      return 0;
    }
    const out = (line: string) => this.io.out(`${line}\n`);
    out(
      `${detail.room.title} (${RoomsCli.short(room.id)})  ${detail.room.repository} at ${detail.room.baseCommit.slice(0, 7)}`,
    );
    out(
      `${detail.mode === 'assisted' ? 'Assisted' : 'Supervised'}, ${detail.paused ? 'paused' : 'active'}${detail.rehearsal ? ', rehearsing' : ''}; the lead is ${detail.lead === 'working' ? 'working' : detail.lead === 'error' ? 'stopped with an error' : 'idle'}`,
    );
    if (detail.folder) out(`Room folder: ${detail.folder}`);
    if (detail.projectFolder) out(`Project: ${detail.projectFolder}`);
    if (detail.playbook) {
      out(
        `Playbook: ${detail.playbook}${playbook ? ` (${playbook.origin === 'room' ? 'in the room’s folder' : 'in the project'})` : ''}` +
          `${detail.stages.length ? `; stages ${detail.stages.map((stage) => (stage === detail.stage ? `[${stage}]` : stage)).join(' > ')}` : ''}`,
      );
      if (playbook?.error) out(`  Not valid: ${playbook.error}`);
      for (const trigger of playbook?.triggers ?? [])
        out(
          `  Trigger ${trigger.id}: ${trigger.cron ?? `every ${trigger.every ?? ''}`}${trigger.tool ? `, ${trigger.tool}` : ''}` +
            `${trigger.nextRun === null ? '' : `, next ${new Date(trigger.nextRun).toLocaleString()}`}`,
        );
    } else {
      const names = (
        await roomsPlaybooks({ ...this.call, query: { repository: room.repository, roomId: room.id } }).catch(
          () => undefined,
        )
      )?.data.map((choice) => choice.name);
      out(`Playbook: none${names?.length ? `; it can follow ${names.join(', ')}` : ''}`);
    }
    const waiting = this.waiting(detail);
    out(waiting.length ? 'Waiting for you:' : 'Nothing waits for you.');
    for (const item of waiting) out(`  ${item.kind} ${item.id}  ${item.text}`);
    if (runs.length) out('Last runs:');
    for (const run of runs.slice(0, 5)) out(`  ${this.runLine(run)}`);
    return 0;
  }

  private waiting(detail: RoomDetail): { kind: string; id: string; text: string }[] {
    return [
      ...detail.actions
        .filter((action) => action.state === 'pending')
        .map((action) => ({
          kind: action.kind === 'advance' ? 'stage' : action.kind === 'playbook' ? 'playbook' : 'draft',
          id: RoomsCli.short(action.id),
          text: `${action.name}: ${action.summary}`,
        })),
      ...detail.tasks
        .filter((task) => task.state === 'proposed' || task.state === 'submitted')
        .map((task) => ({
          kind: 'task',
          id: RoomsCli.short(task.id),
          text: `${task.title} (${task.state === 'proposed' ? 'proposed' : 'ready to integrate'})`,
        })),
      ...detail.leadQuestions.map((question) => ({
        kind: 'question',
        id: question.id,
        text: `the lead asks: ${RoomsCli.asked(question)}`,
      })),
      ...detail.tasks.flatMap((task) =>
        task.state === 'running'
          ? task.questions.map((question) => ({
              kind: 'question',
              id: question.id,
              text: `the worker on ${task.title} asks: ${RoomsCli.asked(question)}`,
            }))
          : [],
      ),
    ];
  }

  private async runs(room: Room, number: string | undefined): Promise<number> {
    const runs = (await roomsListRuns({ ...this.call, path: { roomId: room.id } })).data;
    const one = number === undefined ? undefined : runs.find((run) => run.number === Number(number.replace(/^#/, '')));
    if (number !== undefined && !one) {
      this.io.err(`pi-kit: this room has no run ${number}.\n`);
      return 1;
    }
    if (this.switches.has('--json')) {
      this.io.out(`${JSON.stringify(one ?? runs)}\n`);
      return 0;
    }
    if (!one) {
      if (!runs.length) this.io.out('No runs yet: a run starts each time the lead is woken.\n');
      for (const run of runs) this.io.out(`${this.runLine(run)}\n`);
      return 0;
    }
    this.io.out(`${this.runLine(one)}\n`);
    for (const step of one.steps) {
      this.io.out(
        `  ${step.state.padEnd(9)} ${step.kind} ${step.name}${step.state === 'waiting' ? '' : `  ${RoomsCli.took(step.startedAt, step.endedAt)}`}\n      $ ${step.detail}\n`,
      );
      const lines = (step.output ?? '').split('\n').filter((line) => line.trim());
      for (const line of lines.slice(0, RoomsCli.OUTPUT_LINES)) this.io.out(`      ${line}\n`);
      if (lines.length > RoomsCli.OUTPUT_LINES)
        this.io.out(`      … ${lines.length - RoomsCli.OUTPUT_LINES} more lines; --json has all of it\n`);
    }
    if (one.summary) this.io.out(`\n${one.summary}\n`);
    return 0;
  }

  private runLine(run: RoomRun): string {
    const cause = {
      owner: 'you asked',
      schedule: 'schedule',
      poll: 'new items',
      approval: 'your decision',
      stage: 'stage change',
      agent: 'agent',
    }[run.cause];
    return `#${run.number}  ${run.state.padEnd(7)}  ${RoomsCli.took(run.startedAt, run.endedAt).padEnd(7)}  ${cause}${run.trigger ? ` ${run.trigger}` : ''}: ${run.title}`;
  }

  private async decide(room: Room, id: string, approve: boolean): Promise<number> {
    const detail = (await roomsDetail({ ...this.call, path: { roomId: room.id } })).data;
    const action = detail.actions.find((candidate) => candidate.state === 'pending' && candidate.id.startsWith(id));
    if (action) {
      const decided = (
        await roomsDecide({
          ...this.call,
          path: { roomId: room.id, actionId: action.id },
          body: { decision: approve ? 'approve' : 'discard' },
        })
      ).data;
      this.io.out(`${action.name}: ${decided.state}${decided.result ? `\n${decided.result}` : ''}\n`);
      return decided.state === 'failed' ? 1 : 0;
    }
    const task = detail.tasks.find((candidate) => candidate.id.startsWith(id));
    const path = { roomId: room.id, taskId: task?.id ?? '' };
    if (task?.state === 'proposed') {
      if (approve) await roomsApprove({ ...this.call, path, body: {} });
      else await roomsDecline({ ...this.call, path });
      this.io.out(approve ? `Approved "${task.title}"; a worker starts on it here.\n` : `Declined "${task.title}".\n`);
      return 0;
    }
    if (task?.state === 'submitted' && approve) {
      await roomsIntegrate({ ...this.call, path });
      this.io.out(`Integrated "${task.title}" into the room's project folder.\n`);
      return 0;
    }
    if (task?.state === 'running' && !approve) {
      await roomsStop({ ...this.call, path });
      this.io.out(`Asked the worker on "${task.title}" to stop.\n`);
      return 0;
    }
    this.io.err(
      `pi-kit: nothing with the id ${id} waits for that in this room. "pi-kit rooms show" lists what does.\n`,
    );
    return 1;
  }

  private async answer(room: Room, id: string, text: string): Promise<number> {
    const detail = (await roomsDetail({ ...this.call, path: { roomId: room.id } })).data;
    const task = detail.tasks.find((candidate) => candidate.questions.some((question) => question.id === id));
    const question =
      detail.leadQuestions.find((candidate) => candidate.id === id) ??
      task?.questions.find((candidate) => candidate.id === id);
    if (!question) {
      this.io.err(`pi-kit: nobody asks ${id} in this room. "pi-kit rooms show" lists the questions.\n`);
      return 1;
    }
    const yes = ['yes', 'y', 'true'].includes(text.toLowerCase());
    const body = {
      answers: [question.method === 'confirm' ? { id, confirmed: yes } : { id, value: text }],
    };
    if (task) await roomsAnswer({ ...this.call, path: { roomId: room.id, taskId: task.id }, body });
    else await roomsAnswerLead({ ...this.call, path: { roomId: room.id }, body });
    this.io.out('Answered.\n');
    return 0;
  }

  private async watch(room: Room): Promise<number> {
    const response = await fetch(`${this.call.baseUrl}/api/rooms/${room.id}/events?after=0`, {
      headers: { Authorization: `Bearer ${this.call.auth}` },
    });
    if (!response.ok || !response.body) {
      this.io.err(`pi-kit: the room's stream answered ${response.status}.\n`);
      return 1;
    }
    const decoder = new TextDecoder();
    const said = new Set<string>();
    const speaking = new Map<string, string>();
    let writing = '';
    let pending = '';
    let lead = '';
    const line = (text: string): void => {
      this.io.out(`${writing ? '\n' : ''}${text ? `${text}\n` : ''}`);
      writing = '';
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        const told = JSON.parse(raw) as RoomStreamLine;
        if (told.type === 'live') {
          const who = told.live.role ?? told.live.actor;
          if (told.live.done) {
            if (writing === told.live.id) line('');
            if (speaking.delete(told.live.id) && told.live.actor !== 'worker') said.add(who);
          } else if (told.live.text) {
            if (writing !== told.live.id || told.live.reset) {
              this.io.out(`${writing ? '\n' : ''}[${who}] `);
              writing = told.live.id;
            }
            this.io.out(told.live.text);
            speaking.set(told.live.id, who);
          } else if (told.live.activity) line(`    ${who} uses ${told.live.activity}`);
        } else if (told.type === 'event') {
          const who = told.event.role ?? told.event.actor;
          if (!(told.event.kind === 'message' && said.delete(who))) line(`[${who}] ${told.event.text}`);
        } else if (told.type === 'run') line(`    run ${this.runLine(told.run)}`);
        else if (told.type === 'lead' && told.state !== lead) {
          lead = told.state;
          line(`    the lead is ${told.state}${told.questions?.length ? ' and asks you something' : ''}`);
        }
      }
    }
    return 0;
  }

  private static asked(question: RoomTaskQuestion): string {
    const choices =
      question.method === 'confirm'
        ? ' (yes or no)'
        : question.options?.length
          ? ` (${question.options.join(', ')})`
          : '';
    return `${question.title}${choices}`;
  }

  private static short(id: string): string {
    return id.slice(0, 8);
  }

  private static took(start: number, end: number | null): string {
    if (end === null) return 'running';
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return seconds < 1 ? '<1s' : `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
}
