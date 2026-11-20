import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ApiClient,
  EntryApiClient,
  roomsApprove,
  roomsDecide,
  roomsDecline,
  roomsDetail,
  roomsEvents,
  roomsIntegrate,
  roomsPost,
  roomsAnswer,
  roomsAnswerLead,
  roomsStop,
  roomsUpdate,
  roomsWorkers,
  threadsGetProtection,
  unwrap,
  type TypedClient,
} from '@pi-kit/api';
import type {
  RoomAction,
  RoomMemoryEntry,
  RoomTaskAnswer,
  RoomTaskQuestion,
  Room,
  RoomEvent,
  RoomImage,
  RoomLeadState,
  RoomMode,
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
  readonly mode = signal<RoomMode>('supervised');
  readonly paused = signal(false);
  readonly playbook = signal<string | null>(null);
  readonly stage = signal<string | null>(null);
  readonly stages = signal<string[]>([]);
  readonly actions = signal<RoomAction[]>([]);
  readonly memory = signal<RoomMemoryEntry[]>([]);
  readonly pendingActions = computed(() => this.actions().filter((action) => action.state === 'pending'));
  readonly protection = signal<ThreadProtection | undefined>(undefined);
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
    this.mode.set('supervised');
    this.paused.set(false);
    this.playbook.set(null);
    this.stage.set(null);
    this.stages.set([]);
    this.actions.set([]);
    this.memory.set([]);
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
      if (route === 'lead' && this.room()?.id === room.id && this.lead() === 'idle') this.lead.set('working');
      return true;
    } catch (error) {
      if (this.room()?.id === room.id) this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.sending.set(false);
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

  async update(change: { mode?: RoomMode; paused?: boolean }): Promise<void> {
    const room = this.room();
    if (!room) return;
    this.error.set(undefined);
    try {
      const detail = await unwrap(roomsUpdate({ client: this.client(room), path: { roomId: room.id }, body: change }));
      if (this.room()?.id !== room.id) return;
      this.mode.set(detail.mode);
      this.paused.set(detail.paused);
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
  }

  private putMemory(entry: RoomMemoryEntry): void {
    this.memory.update((memory) => {
      const rest = memory.filter((existing) => !(existing.scope === entry.scope && existing.key === entry.key));
      return entry.text.trim() ? [...rest, entry] : rest;
    });
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
      this.mode.set(detail.mode);
      this.paused.set(detail.paused);
      this.playbook.set(detail.playbook);
      this.stage.set(detail.stage);
      this.stages.set(detail.stages);
      this.actions.set(detail.actions);
      this.memory.set(detail.memory);
      this.error.set(undefined);
      if (detail.leadThreadId) void this.loadProtection(room, detail.leadThreadId, generation);
      void this.loadWorkers();
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
    while (generation === this.generation) {
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
            else if (line.type === 'room') {
              this.mode.set(line.mode);
              this.paused.set(line.paused);
              if (line.stage !== undefined) this.stage.set(line.stage);
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
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private add(event: RoomEvent): void {
    this.events.update((events) =>
      events.some((existing) => existing.seq === event.seq) ? events : [...events, event].sort((a, b) => a.seq - b.seq),
    );
  }
}
