import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { EventBusController } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { PLUGIN_CHANNEL_LIST, replyChannel } from '@pi-kit/protocol';

export interface PluginReplyShape {
  requestId: string;
  ok: boolean;
  [key: string]: unknown;
}
/**
 * Answers one request of an extension. `signal` is the life of the request: it aborts when the session is stopped (`cancel`) or unbound (closed, or bound again), so what
 * the host started for the request (a model call) ends with it. A host that takes three parameters is one that has nothing to abort.
 */
export type PluginHost = (threadId: string, channel: string, payload: unknown, signal?: AbortSignal) => Promise<PluginReplyShape | undefined>;

/** The channel on which pi-kit says, synchronously inside the request's `emit`, that a host will answer the request (doc/docs/plugins.md). */
const acceptedChannel = (channel: string): string => `${channel}:accepted`;

/** What a request still open when its session is unbound is answered with. */
const CLOSED = { ok: false, code: 'failed', error: 'The session closed before pi-kit answered.' } as const;
/** What a request still open when its session is stopped is answered with. */
const CANCELLED = { ok: false, code: 'failed', error: 'The request was cancelled before pi-kit answered.' } as const;

interface PendingRequest {
  channel: string;
  requestId: string;
}

/** One session's subscriptions, the requests it has in flight, and the signal those share until the next `cancel` (which starts a new one). */
interface Binding {
  bus: EventBusController;
  controller: AbortController;
  offs: (() => void)[];
  pending: Set<PendingRequest>;
}

/**
 * Plugin request routing belongs to the plugin host, independently of agent-session orchestration. A session is bound once; its binding owns every request it accepts
 * until the session is stopped (`cancel`) or unbound, when the requests are aborted and answered on the session's own reply channels. pi's bus is synchronous, so the
 * acceptance is said inside the request's `emit`: a caller that listens for it before emitting learns at once whether anyone is there, without a clock.
 */
@Injectable()
export class PiPluginService implements OnModuleDestroy {
  private readonly logger = new Logger(PiPluginService.name);
  private fallback?: PluginHost;
  private readonly hosts = new Map<string, PluginHost>();
  private readonly bindings = new Map<string, Binding>();

  setDefault(host: PluginHost | undefined): void { this.fallback = host; }

  register(channels: readonly string[], host: PluginHost): () => void {
    for (const channel of channels) this.hosts.set(channel, host);
    return () => {
      for (const channel of channels) if (this.hosts.get(channel) === host) this.hosts.delete(channel);
    };
  }

  /** Listens for the plugin requests of a session. The same thread bound again retires its earlier binding first: nothing of the old session reaches the new one. */
  bind(threadId: string, bus: EventBusController): void {
    this.unbind(threadId);
    const binding: Binding = { bus, controller: new AbortController(), offs: [], pending: new Set() };
    this.bindings.set(threadId, binding);
    for (const channel of PLUGIN_CHANNEL_LIST) {
      binding.offs.push(bus.on(channel, (payload) => this.serve(threadId, binding, channel, payload)));
    }
  }

  /** Ends a session's binding: nothing of it is listened to any more, what its hosts started is aborted, and every request still open is answered as failed. */
  unbind(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    this.bindings.delete(threadId);
    for (const off of binding.offs) off();
    this.end(binding, CLOSED);
  }

  /**
   * Stops the requests of a session that stays open (the person pressed Stop): what their hosts started is aborted and each is answered as cancelled, so the extension command
   * that asked ends with the run. The session keeps its binding; its next request gets a signal of its own, untouched by this.
   */
  cancel(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    this.end(binding, CANCELLED);
    binding.controller = new AbortController();
  }

  /** Aborts the signal the binding's open requests share and answers each of them `how`. The set is emptied before the answers go out, so an answer that is heard synchronously cannot be given twice. */
  private end(binding: Binding, how: typeof CLOSED | typeof CANCELLED): void {
    binding.controller.abort();
    const open = [...binding.pending];
    binding.pending.clear();
    for (const { channel, requestId } of open) binding.bus.emit(replyChannel(channel), { requestId, ...how });
  }

  private serve(threadId: string, binding: Binding, channel: string, payload: unknown): void {
    const host = this.hosts.get(channel) ?? this.fallback;
    const requestId = (payload as { requestId?: unknown } | null | undefined)?.requestId;
    if (!host || typeof requestId !== 'string' || binding.controller.signal.aborted) return;
    // The request's signal is the binding's as it stands now: a `cancel` aborts it and answers this request, and later requests get the next one.
    const { signal } = binding.controller;
    // Said before the caller's `emit` returns: the request has an owner, and its reply will come.
    const request: PendingRequest = { channel, requestId };
    binding.pending.add(request);
    binding.bus.emit(acceptedChannel(channel), { requestId });
    // A request that was answered already (its session stopped or closed) is over: the host's late answer stays off the bus.
    const answer = (reply: PluginReplyShape): void => {
      if (binding.pending.delete(request)) binding.bus.emit(replyChannel(channel), reply);
    };
    void Promise.resolve()
      .then(() => binding.pending.has(request) ? host(threadId, channel, payload, signal) : undefined)
      .then((reply) => {
        if (reply) answer(reply);
        else answer({ requestId, ok: false, code: 'invalid', error: 'pi-kit has no handler for this request.' });
      })
      .catch((error: unknown) => {
        this.logger.warn(`Plugin request ${channel} failed: ${error instanceof Error ? error.message : String(error)}`);
        answer({ requestId, ok: false, code: 'failed', error: 'pi-kit could not answer the request.' });
      });
  }

  onModuleDestroy(): void {
    for (const threadId of [...this.bindings.keys()]) this.unbind(threadId);
    this.hosts.clear();
    this.fallback = undefined;
  }
}
