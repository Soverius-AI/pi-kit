import { z } from 'zod';

/**
 * pi's queue of messages that wait for the running turn: `steer` messages are delivered after the current
 * turn's tool calls, `followUp` messages after the run. The bar lists steering first, then follow-ups: the order pi delivers them in.
 */
export const QueueKindSchema = z.enum(['steer', 'followUp']);
export type QueueKind = z.infer<typeof QueueKindSchema>;

export const QueueSnapshotSchema = z.object({
  steering: z.array(z.string()),
  followUp: z.array(z.string()),
}).meta({ id: 'QueueSnapshot' });
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;

/** One message of the queue, as a row of the bar. */
export interface QueueItem {
  kind: QueueKind;
  /** Position inside its own list (steering and follow-ups are numbered separately). */
  index: number;
  text: string;
}

export const queueItems = (queue: QueueSnapshot): QueueItem[] => [
  ...queue.steering.map((text, index): QueueItem => ({ kind: 'steer', index, text })),
  ...queue.followUp.map((text, index): QueueItem => ({ kind: 'followUp', index, text })),
];

/** `POST /threads/:id/queue/promote` and `.../remove`: the message is named by list, position and text, so a queue that moved on is not edited blindly. */
export const QueueTargetSchema = z.object({
  kind: QueueKindSchema,
  index: z.number().int().nonnegative(),
  text: z.string(),
}).meta({ id: 'QueueTarget' });
export type QueueTarget = z.infer<typeof QueueTargetSchema>;

/**
 * What `merge` queues instead of the whole queue: every text in delivery order, joined by blank lines, as one steer. A queue of
 * follow-ups only stays a follow-up (nothing in it was asked to interrupt the turn).
 */
export function mergeQueue(queue: QueueSnapshot): { kind: QueueKind; text: string } | undefined {
  const texts = [...queue.steering, ...queue.followUp];
  if (texts.length === 0) return undefined;
  return { kind: queue.steering.length > 0 ? 'steer' : 'followUp', text: texts.join('\n\n') };
}
