import { DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { EntryApiClient, type TypedClient } from '@pi-kit/api';
import { OpenRoomStore } from './open-room.store';

export interface RoomPanelOptions {
  client: TypedClient;
  path: { roomId: string };
  signal: AbortSignal;
}

/** Shared request lifecycle for the two room panels; ordinary polls never invalidate an in-flight read. */
export class RoomPanelState<T> {
  private readonly room = inject(OpenRoomStore);
  private readonly api = inject(EntryApiClient);
  readonly context = computed(
    () => {
      const room = this.room.room();
      return room ? { id: room.id, host: room.hostInstanceId, key: this.scopeKey?.() } : undefined;
    },
    { equal: (a, b) => a?.id === b?.id && a?.host === b?.host && a?.key === b?.key },
  );
  private generation = 0;
  private mutationFailed = false;
  private activeContext: ReturnType<typeof this.context>;
  private destroyed = false;
  private reading: { abort: AbortController; promise: Promise<void> } | undefined;
  private mutation: AbortController | undefined;
  readonly visible = signal(false);
  readonly roomId = computed(() => this.context()?.id);
  readonly status = signal<T | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal<string | undefined>(undefined);

  constructor(
    private readonly fetch: (options: RoomPanelOptions) => Promise<T>,
    interval: number,
    hooks: { reset?: () => void; tick?: () => void } = {},
    private readonly scopeKey?: () => string,
  ) {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.invalidate();
    });
    effect((cleanup) => {
      const scope = this.context();
      const visible = this.visible();
      this.invalidate();
      this.activeContext = visible ? scope : undefined;
      this.status.set(undefined);
      this.mutationFailed = false;
      this.error.set(undefined);
      untracked(() => hooks.reset?.());
      if (!scope || !visible) return;
      void this.refresh();
      const timer = setInterval(() => {
        hooks.tick?.();
        if (!this.busy()) void this.refresh();
      }, interval);
      cleanup(() => clearInterval(timer));
    });
  }

  refresh(): Promise<void> {
    if (this.reading) return this.reading.promise;
    const request = { abort: new AbortController(), promise: Promise.resolve() };
    const options = this.options(request.abort.signal);
    if (!options) return request.promise;
    const generation = this.generation;
    this.reading = request;
    request.promise = (async () => {
      try {
        const value = await this.fetch(options);
        if (this.current(generation)) {
          this.status.set(value);
          if (!this.mutationFailed) this.error.set(undefined);
        }
      } catch (error) {
        if (this.current(generation) && !this.mutationFailed) this.error.set(message(error));
      } finally {
        if (this.reading === request) this.reading = undefined;
      }
    })();
    return request.promise;
  }

  async mutate<R>(
    action: (options: RoomPanelOptions) => Promise<R>,
    apply?: (result: R) => void,
    refresh = false,
  ): Promise<boolean> {
    if (this.busy()) return false;
    const operation = new AbortController();
    const options = this.options(operation.signal);
    if (!options) return false;
    this.invalidate();
    const generation = this.generation;
    this.mutation = operation;
    this.busy.set(true);
    this.mutationFailed = false;
    this.error.set(undefined);
    try {
      const result = await action(options);
      if (!this.current(generation)) return false;
      apply?.(result);
      if (refresh) await this.refresh();
      return this.current(generation);
    } catch (error) {
      if (this.current(generation)) {
        this.mutationFailed = true;
        this.error.set(message(error));
      }
      return false;
    } finally {
      if (this.mutation === operation) {
        this.mutation = undefined;
        this.busy.set(false);
      }
    }
  }

  private invalidate(): void {
    this.generation++;
    this.reading?.abort.abort();
    this.reading = undefined;
    this.mutation?.abort();
    this.mutation = undefined;
    this.busy.set(false);
  }
  private current(generation: number): boolean {
    return !this.destroyed && generation === this.generation && this.visible() && this.context() === this.activeContext;
  }
  private options(signal: AbortSignal): RoomPanelOptions | undefined {
    const scope = this.context();
    return !this.destroyed && this.visible() && scope && scope === this.activeContext
      ? { client: this.api.forOwner(scope.host), path: { roomId: scope.id }, signal }
      : undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
