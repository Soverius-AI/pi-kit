import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { mergeQueue, type QueueKind, type QueueSnapshot, type QueueTarget } from '@pi-kit/protocol';

export interface PiImage {
  data: string;
  mimeType: string;
}

/** A queue action named a message that has been delivered or changed by another client. */
export class QueueStaleError extends Error {
  constructor() {
    super('The queue changed in the meantime.');
  }
}

interface QueuedInput {
  text: string;
  images: PiImage[];
}
type Inputs = { steering: QueuedInput[]; followUp: QueuedInput[] };

/** Queue edits and image ownership for one SDK session; the SDK owns canonical texts and delivery. */
export class SessionQueue {
  private entries: Inputs = { steering: [], followUp: [] };
  /** Edits (clear and requeue) run one after the other; a message waits for the edits requested before it, never the other way round. */
  private editing: Promise<unknown> = Promise.resolve();
  /**
   * The message being sent, carried through the SDK's awaits to the `queue_update` it emits when it appends that very message. An
   * input extension may hold a message for as long as a dialog takes; until then it is not in the queue, so edits do not wait for it
   * and the messages sent meanwhile are attributed on their own. The key keeps a steer's pictures off a follow-up an extension
   * appends while it handles that steer (and the other way round): only an entry of the same kind is this send's own.
   */
  private readonly sending = new AsyncLocalStorage<{ key: keyof Inputs; images: PiImage[] }>();

  constructor(private readonly session: AgentSession) {
    this.observe(this.snapshot());
    session.subscribe((event) => {
      if (event.type === 'queue_update') this.observe(event);
    });
  }

  snapshot(): QueueSnapshot {
    return { steering: [...this.session.getSteeringMessages()], followUp: [...this.session.getFollowUpMessages()] };
  }

  async enqueue(kind: QueueKind, text: string, images: PiImage[]): Promise<'queued' | 'handled'> {
    await this.editing;
    return this.send(kind, { text, images });
  }

  promote(target: QueueTarget): Promise<QueueSnapshot> {
    return this.edit((queue) => {
      if (target.kind !== 'followUp') return queue;
      const followUp = [...queue.followUp];
      const [input] = followUp.splice(target.index, 1);
      return { steering: [...queue.steering, input], followUp };
    }, target);
  }

  remove(target: QueueTarget): Promise<QueueSnapshot> {
    return this.edit((queue) => {
      const key = target.kind === 'steer' ? 'steering' : 'followUp';
      return { ...queue, [key]: queue[key].filter((_, index) => index !== target.index) };
    }, target);
  }

  merge(): Promise<QueueSnapshot> {
    return this.edit((queue) => {
      const merged = mergeQueue(this.snapshot());
      if (!merged) return queue;
      const input = { text: merged.text, images: [...queue.steering, ...queue.followUp].flatMap((entry) => entry.images) };
      return merged.kind === 'steer' ? { steering: [input], followUp: [] } : { steering: [], followUp: [input] };
    });
  }

  clear(): Promise<QueueSnapshot> {
    return this.edit(() => ({ steering: [], followUp: [] }));
  }

  private send(kind: QueueKind, input: QueuedInput, source?: 'extension'): Promise<'queued' | 'handled'> {
    const images = input.images.length ? input.images.map((image) => ({ type: 'image' as const, ...image })) : undefined;
    const sent = { key: kind === 'steer' ? ('steering' as const) : ('followUp' as const), images: input.images };
    return this.sending.run(sent, () => this.session[kind](input.text, images, source ? { source } : undefined));
  }

  /** The SDK appends one queued input or consumes inputs in delivery order; identical text is not an identity. */
  private observe(queue: { steering: readonly string[]; followUp: readonly string[] }): void {
    const sent = this.sending.getStore();
    const sync = (key: keyof Inputs): QueuedInput[] => {
      const before = this.entries[key];
      const texts = queue[key];
      const consumed = Math.max(0, before.length - texts.length);
      return texts.map((text, index) => ({ text, images: before[consumed + index]?.images ?? (sent?.key === key ? sent.images : []) }));
    };
    this.entries = { steering: sync('steering'), followUp: sync('followUp') };
  }

  private edit(change: (queue: Inputs) => Inputs, target?: QueueTarget): Promise<QueueSnapshot> {
    const result = this.editing.then(async () => {
      if (target) {
        const list = target.kind === 'steer' ? this.entries.steering : this.entries.followUp;
        if (list[target.index]?.text !== target.text) throw new QueueStaleError();
      }
      // Capture complete inputs before clearQueue emits its empty state; rebuilds never look attachments up by text.
      const after = change(this.entries);
      this.session.clearQueue();
      for (const input of after.steering) await this.send('steer', input, 'extension');
      for (const input of after.followUp) await this.send('followUp', input, 'extension');
      return this.snapshot();
    });
    this.editing = result.catch(() => undefined);
    return result;
  }
}
