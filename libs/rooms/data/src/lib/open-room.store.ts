import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ApiClient,
  EntryApiClient,
  roomsApprove,
  roomsArchive,
  roomsDecide,
  roomsDecline,
  roomsDetail,
  roomsEvents,
  roomsFireTrigger,
  roomsIntegrate,
  roomsListRuns,
  roomsPlaybookDetail,
  roomsPlaybooks,
  roomsPost,
  roomsAnswer,
  roomsAnswerLead,
  roomsStop,
  roomsTryTool,
  roomsUpdate,
  roomsWorkers,
  threadsGetProtection,
  threadsSetProtection,
  unwrap,
  WORKBENCH,
  type TypedClient,
} from '@pi-kit/api';
import type {
  EnvironmentLook,
  PlaybookDetail,
  PlaybookFireResult,
  PlaybookSummary,
  PlaybookTryResult,
  RoomAction,
  RoomMemoryEntry,
  RoomTaskAnswer,
  RoomTaskQuestion,
  Room,
  RoomEvent,
  RoomImage,
  RoomLeadState,
  RoomLive,
  RoomMode,
  RoomRun,
  RoomStreamLine,
  RoomTask,
  RoomWorkerCandidate,
  ThreadProtection,
} from '@pi-kit/protocol';

export type RoomRoute = 'lead' | 'none';
export type RoomTaskAction = 'approve' | 'decline' | 'stop' | 'integrate';

@Injectable({ providedIn: 'root' })
export class OpenRoomStore {
  private readonly entry = inject(EntryApiClient);
  private readonly api = inject(ApiClient);
  private readonly workbench = inject(WORKBENCH);
  private generation = 0;
  private abort: AbortController | undefined;

  readonly room = signal<Room | undefined>(undefined);
  readonly summary = signal('');
  readonly events = signal<RoomEvent[]>([]);
  readonly tasks = signal<RoomTask[]>([]);
  readonly acting = signal<string | undefined>(undefined);
  readonly workers = signal<RoomWorkerCandidate[]>([]);
  readonly workersLoading = signal(false);
  readonly lead = signal<RoomLeadState>('idle');
  readonly leadQuestions = signal<RoomTaskQuestion[]>([]);
  readonly leadThreadId = signal<string | null>(null);
  readonly projectFolder = signal<string | null>(null);
  readonly folder = signal<string | null>(null);
  readonly listChanges = signal(0);
  readonly mode = signal<RoomMode>('supervised');
  readonly paused = signal(false);
  readonly rehearsal = signal(false);
  readonly playbook = signal<string | null>(null);
  /** Read when the panel opens, and again whenever the playbook changes. */
  readonly playbookDetail = signal<PlaybookDetail | undefined>(undefined);
  readonly playbookDetailError = signal<string | undefined>(undefined);
  readonly stage = signal<string | null>(null);
  readonly stages = signal<string[]>([]);
  readonly actions = signal<RoomAction[]>([]);
  readonly memory = signal<RoomMemoryEntry[]>([]);
  readonly runs = signal<RoomRun[]>([]);
  readonly live = signal<RoomLive[]>([]);
  /** Undefined until read. */
  readonly playbookChoices = signal<PlaybookSummary[] | undefined>(undefined);
  readonly pendingActions = computed(() => this.actions().filter((action) => action.state === 'pending'));
  readonly protection = signal<ThreadProtection | undefined>(undefined);
  /** The lead's thread when the room runs on the backend this window works on, where its pi session lives. */
  readonly localLeadThreadId = computed(() => {
    const room = this.room();
    const here = this.workbench.ownerId ?? this.workbench.entryId;
    return room && (!here || room.hostInstanceId === here) ? (this.leadThreadId() ?? undefined) : undefined;
  });
  readonly loading = signal(false);
  readonly error = signal<string | undefined>(undefined);
  readonly connected = signal(false);
  readonly sending = signal(false);
  readonly roomId = computed(() => this.room()?.id);

  open(room: Room): void {
    if (this.room()?.id === room.id) return;
    this.close();
    const generation = this.generation;
    this.room.set(room);
    this.loading.set(true);
    void this.load(room, generation);
  }

  close(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    this.room.set(undefined);
    this.summary.set('');
    this.events.set([]);
    this.tasks.set([]);
    this.acting.set(undefined);
    this.workers.set([]);
    this.lead.set('idle');
    this.leadQuestions.set([]);
    this.leadThreadId.set(null);
    this.projectFolder.set(null);
    this.folder.set(null);
    this.mode.set('supervised');
    this.paused.set(false);
    this.rehearsal.set(false);
    this.playbook.set(null);
    this.playbookDetail.set(undefined);
    this.playbookDetailError.set(undefined);
    this.stage.set(null);
    this.stages.set([]);
    this.actions.set([]);
    this.memory.set([]);
    this.runs.set([]);
    this.live.set([]);
    this.playbookChoices.set(undefined);
    this.protection.set(undefined);
    this.loading.set(false);
    this.error.set(undefined);
    this.connected.set(false);
    this.sending.set(false);
  }

  async post(text: string, route: RoomRoute, images: readonly RoomImage[] = []): Promise<boolean> {
    const room = this.room();
    const trimmed = text.trim();
    if (!room || !trimmed) return false;
    this.sending.set(true);
    this.error.set(undefined);
    try {
      const event = await unwrap(
        roomsPost({
          client: this.client(room),
          path: { roomId: room.id },
          body: { text: trimmed, route, ...(route === 'lead' && images.length ? { images: [...images] } : {}) },
        }),
      );
      if (this.room()?.id === room.id) this.add(event);
      return true;
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.sending.set(false);
    }
  }

  async loadPlaybooks(): Promise<void> {
    const room = this.room();
    if (!room) return;
    try {
      const found = await unwrap(
        roomsPlaybooks({ client: this.client(room), query: { repository: room.repository, roomId: room.id } }),
      );
      if (this.room()?.id === room.id) this.playbookChoices.set(found);
    } catch {
      if (this.room()?.id === room.id) this.playbookChoices.set([]);
    }
  }

  async loadPlaybookDetail(): Promise<void> {
    const room = this.room();
    if (!room) return;
    if (!this.playbook()) {
      this.playbookDetail.set(undefined);
      return;
    }
    try {
      const detail = await unwrap(roomsPlaybookDetail({ client: this.client(room), path: { roomId: room.id } }));
      if (this.room()?.id !== room.id) return;
      this.playbookDetail.set(detail);
      this.playbookDetailError.set(undefined);
      if (detail.config) this.stages.set(detail.config.stages);
      if (detail.stage) this.stage.set(detail.stage);
    } catch (error) {
      if (this.room()?.id === room.id)
        this.playbookDetailError.set(error instanceof Error ? error.message : String(error));
    }
  }

  /** Runs a playbook tool, or shows the call a safe output would make; the error text on failure. */
  async tryTool(tool: string, params: Record<string, string>): Promise<PlaybookTryResult | string> {
    const room = this.room();
    if (!room) return '';
    try {
      return await unwrap(
        roomsTryTool({ client: this.client(room), path: { roomId: room.id }, body: { tool, params } }),
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async fireTrigger(triggerId: string, dry: boolean): Promise<PlaybookFireResult | string> {
    const room = this.room();
    if (!room) return '';
    try {
      const result = await unwrap(
        roomsFireTrigger({ client: this.client(room), path: { roomId: room.id, triggerId }, body: { dry } }),
      );
      if (!dry) void this.loadPlaybookDetail();
      return result;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async loadWorkers(): Promise<void> {
    const room = this.room();
    if (!room) return;
    this.workersLoading.set(true);
    try {
      const workers = await unwrap(roomsWorkers({ client: this.client(room), path: { roomId: room.id } }));
      if (this.room()?.id === room.id) this.workers.set(workers);
    } catch {
      if (this.room()?.id === room.id) this.workers.set([]);
    } finally {
      if (this.room()?.id === room.id) this.workersLoading.set(false);
    }
  }

  machineName(environmentId: string | null | undefined): string | undefined {
    return environmentId
      ? this.workers().find((candidate) => candidate.environmentId === environmentId)?.name
      : undefined;
  }

  /** The look a machine chose; an outside agent has none. */
  machineLook(environmentId: string | null | undefined): EnvironmentLook | undefined {
    return environmentId
      ? this.workers().find((candidate) => candidate.environmentId === environmentId)?.look
      : undefined;
  }

  environmentName(environmentId: string): string | undefined {
    const worker = this.workers().find((candidate) => candidate.environmentId === environmentId);
    return worker && !worker.local ? worker.name : undefined;
  }

  async act(taskId: string, action: RoomTaskAction, environmentId?: string): Promise<void> {
    const room = this.room();
    if (!room) return;
    const options = { client: this.client(room), path: { roomId: room.id, taskId } };
    this.acting.set(taskId);
    this.error.set(undefined);
    try {
      const task = await unwrap(
        action === 'approve'
          ? roomsApprove({ ...options, body: environmentId ? { environmentId } : {} })
          : action === 'decline'
            ? roomsDecline(options)
            : action === 'stop'
              ? roomsStop(options)
              : roomsIntegrate(options),
      );
      if (this.room()?.id === room.id) this.putTask(task);
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.acting() === taskId) this.acting.set(undefined);
    }
  }

  async answer(taskId: string, answers: RoomTaskAnswer['answers']): Promise<void> {
    const room = this.room();
    if (!room) return;
    this.acting.set(taskId);
    this.error.set(undefined);
    try {
      const task = await unwrap(
        roomsAnswer({ client: this.client(room), path: { roomId: room.id, taskId }, body: { answers } }),
      );
      if (this.room()?.id === room.id) this.putTask(task);
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.acting() === taskId) this.acting.set(undefined);
    }
  }

  async update(change: {
    title?: string;
    mode?: RoomMode;
    paused?: boolean;
    playbook?: string | null;
    rehearsal?: boolean;
  }): Promise<void> {
    const room = this.room();
    if (!room) return;
    this.error.set(undefined);
    try {
      const detail = await unwrap(roomsUpdate({ client: this.client(room), path: { roomId: room.id }, body: change }));
      if (this.room()?.id !== room.id) return;
      if (detail.room.title !== room.title) this.listChanges.update((count) => count + 1);
      this.room.set(detail.room);
      this.mode.set(detail.mode);
      this.paused.set(detail.paused);
      this.rehearsal.set(detail.rehearsal);
      this.setPlaybook(detail.playbook);
      this.stage.set(detail.stage);
      this.stages.set(detail.stages);
      this.actions.set(detail.actions);
      this.memory.set(detail.memory);
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async archive(stopTasks: boolean): Promise<boolean> {
    const room = this.room();
    if (!room) return false;
    this.error.set(undefined);
    try {
      await unwrap(roomsArchive({ client: this.client(room), path: { roomId: room.id }, body: { stopTasks } }));
      if (this.room()?.id === room.id) this.close();
      this.listChanges.update((count) => count + 1);
      return true;
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** The lead stays read-only either way; off, it runs on the host without the sandbox. */
  async setSandboxed(sandboxed: boolean): Promise<void> {
    const room = this.room();
    const leadThreadId = this.leadThreadId();
    if (!room || !leadThreadId) return;
    this.error.set(undefined);
    try {
      const protection = await unwrap(
        threadsSetProtection({
          client: this.client(room),
          path: { id: leadThreadId },
          body: sandboxed ? { mode: 'sandboxed' } : { mode: 'bypass', confirmBypass: true },
        }),
      );
      if (this.room()?.id === room.id) this.protection.set(protection);
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async decide(actionId: string, decision: 'approve' | 'discard'): Promise<void> {
    const room = this.room();
    if (!room) return;
    this.acting.set(actionId);
    this.error.set(undefined);
    try {
      const action = await unwrap(
        roomsDecide({ client: this.client(room), path: { roomId: room.id, actionId }, body: { decision } }),
      );
      if (this.room()?.id === room.id) this.putAction(action);
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.acting() === actionId) this.acting.set(undefined);
    }
  }

  async answerLead(answers: RoomTaskAnswer['answers']): Promise<void> {
    const room = this.room();
    if (!room) return;
    this.acting.set('lead');
    this.error.set(undefined);
    try {
      const detail = await unwrap(
        roomsAnswerLead({ client: this.client(room), path: { roomId: room.id }, body: { answers } }),
      );
      if (this.room()?.id === room.id) {
        this.leadQuestions.set(detail.leadQuestions);
        this.room.set(detail.room);
      }
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.acting() === 'lead') this.acting.set(undefined);
    }
  }

  private putAction(action: RoomAction): void {
    this.actions.update((actions) => this.upsert(actions, action));
    if (action.kind === 'playbook' && action.state === 'done') void this.loadPlaybooks();
  }

  /** Rereads the detail even for the same playbook: its files, and so the header's stages, may have changed. */
  private setPlaybook(playbook: string | null): void {
    if (playbook !== this.playbook()) this.playbookDetail.set(undefined);
    this.playbook.set(playbook);
    void this.loadPlaybookDetail();
  }

  private putMemory(entry: RoomMemoryEntry): void {
    this.memory.update((memory) => {
      const rest = memory.filter((existing) => !(existing.scope === entry.scope && existing.key === entry.key));
      return entry.text.trim() ? [...rest, entry] : rest;
    });
  }

  private putLive(piece: RoomLive): void {
    this.live.update((live) => {
      if (piece.done) return live.filter((speaker) => speaker.id !== piece.id);
      const known = live.find((speaker) => speaker.id === piece.id);
      const next = { ...piece, text: known && !piece.reset ? known.text + piece.text : piece.text };
      return known ? live.map((speaker) => (speaker.id === piece.id ? next : speaker)) : [...live, next];
    });
  }

  private putRun(run: RoomRun): void {
    this.runs.update((runs) => this.upsert(runs, run).sort((a, b) => b.number - a.number));
  }

  private async loadRuns(room: Room, generation: number, fresh = false): Promise<void> {
    try {
      const runs = await unwrap(roomsListRuns({ client: this.client(room), path: { roomId: room.id } }));
      if (generation !== this.generation) return;
      this.runs.update((live) => {
        if (fresh) return runs;
        const known = new Set(live.map((run) => run.id));
        return [...live, ...runs.filter((run) => !known.has(run.id))].sort((a, b) => b.number - a.number);
      });
    } catch {
      return;
    }
  }

  private putTask(task: RoomTask): void {
    this.tasks.update((tasks) => this.upsert(tasks, task));
  }

  private upsert<T extends { id: string }>(items: T[], item: T): T[] {
    return items.some((existing) => existing.id === item.id)
      ? items.map((existing) => (existing.id === item.id ? item : existing))
      : [...items, item];
  }

  private client(room: Room): TypedClient {
    return this.entry.forOwner(room.hostInstanceId);
  }

  private async load(room: Room, generation: number): Promise<void> {
    try {
      const detail = await unwrap(roomsDetail({ client: this.client(room), path: { roomId: room.id } }));
      if (generation !== this.generation) return;
      this.room.set(detail.room);
      this.summary.set(detail.summary);
      this.events.set(detail.events);
      this.tasks.set(detail.tasks);
      this.lead.set(detail.lead);
      this.leadQuestions.set(detail.leadQuestions);
      this.leadThreadId.set(detail.leadThreadId);
      this.projectFolder.set(detail.projectFolder);
      this.folder.set(detail.folder);
      this.mode.set(detail.mode);
      this.paused.set(detail.paused);
      this.rehearsal.set(detail.rehearsal);
      this.playbook.set(detail.playbook);
      if (detail.playbook) void this.loadPlaybookDetail();
      this.stage.set(detail.stage);
      this.stages.set(detail.stages);
      this.actions.set(detail.actions);
      this.memory.set(detail.memory);
      this.error.set(undefined);
      if (detail.leadThreadId) void this.loadProtection(room, detail.leadThreadId, generation);
      void this.loadWorkers();
      void this.loadPlaybooks();
      void this.loadRuns(room, generation);
    } catch (error) {
      if (generation === this.generation) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
    if (generation === this.generation) void this.follow(room, generation);
  }

  private async loadProtection(room: Room, leadThreadId: string, generation: number): Promise<void> {
    try {
      const protection = await unwrap(threadsGetProtection({ client: this.client(room), path: { id: leadThreadId } }));
      if (generation === this.generation) this.protection.set(protection);
    } catch {
      if (generation === this.generation) this.protection.set(undefined);
    }
  }

  private async follow(room: Room, generation: number): Promise<void> {
    let reconnecting = false;
    while (generation === this.generation) {
      if (reconnecting) void this.loadRuns(room, generation, true);
      reconnecting = true;
      const abort = new AbortController();
      this.abort = abort;
      try {
        await this.api.stream<RoomStreamLine>(
          roomsEvents({
            client: this.client(room),
            path: { roomId: room.id },
            query: { after: this.events().at(-1)?.seq ?? 0 },
            signal: abort.signal,
            parseAs: 'stream',
          }),
          (line) => {
            if (generation !== this.generation) return;
            this.connected.set(true);
            if (line.type === 'event') this.add(line.event);
            else if (line.type === 'task') this.putTask(line.task);
            else if (line.type === 'action') this.putAction(line.action);
            else if (line.type === 'memory') this.putMemory(line.entry);
            else if (line.type === 'run') this.putRun(line.run);
            else if (line.type === 'live') this.putLive(line.live);
            else if (line.type === 'room') {
              const title = line.title;
              if (title && title !== this.room()?.title) {
                this.room.update((current) => current && { ...current, title });
                this.listChanges.update((count) => count + 1);
              }
              this.mode.set(line.mode);
              this.paused.set(line.paused);
              if (line.rehearsal !== undefined) this.rehearsal.set(line.rehearsal);
              if (line.stage !== undefined) this.stage.set(line.stage);
              if (line.playbook !== undefined) this.setPlaybook(line.playbook);
            } else {
              this.lead.set(line.state);
              if (line.questions) this.leadQuestions.set(line.questions);
              else if (line.state !== 'working') this.leadQuestions.set([]);
            }
          },
        );
      } catch {
        if (abort.signal.aborted) return;
      }
      if (generation !== this.generation) return;
      this.connected.set(false);
      this.live.set([]);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private add(event: RoomEvent): void {
    this.events.update((events) =>
      events.some((existing) => existing.seq === event.seq) ? events : [...events, event].sort((a, b) => a.seq - b.seq),
    );
  }
}
