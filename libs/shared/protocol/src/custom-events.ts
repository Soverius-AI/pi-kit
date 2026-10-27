import { z } from 'zod';
import { ComposerRegistrationSchema } from './composer';

/**
 * Fire-and-forget pi signals carried as AG-UI `CUSTOM { name, value }` events.
 * One zod object per event: the backend builds values with these types, the renderer parses with
 * the same schemas. Names are prefixed `pi.`.
 */

export const PiCompactionSchema = z.object({
  phase: z.enum(['start', 'end']),
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
});

/**
 * pi's queue (`queue_update`): how many messages wait for a steer / a follow-up, and what they say. The counts are older than
 * the texts, so an older log replays with counts only.
 */
export const PiQueueSchema = z.object({
  steer: z.number().int().nonnegative(),
  followUp: z.number().int().nonnegative(),
  steerTexts: z.array(z.string()).optional(),
  followUpTexts: z.array(z.string()).optional(),
});

export const PiRetrySchema = z.object({
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  reason: z.string(),
});

export const PiModelSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  thinkingLevel: z.string().optional(),
});

export const PiTreeSchema = z.object({
  /** pi's current leaf entry; `null` when it was moved to before the first entry. */
  leafId: z.string().nullable(),
  changed: z.array(z.string()),
});

/** Extension `setStatus(key, text)`; an empty `text` clears that key. `key` is optional for older emitters. */
export const PiStatusSchema = z.object({ key: z.string().optional(), text: z.string() });

export const PiNotifySchema = z.object({
  level: z.enum(['info', 'warning', 'error']),
  text: z.string(),
});

export const PiUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
  /** Tokens the model had in context for this request (input + cache + output), for the composer's meter. */
  contextTokens: z.number().optional(),
});

export const PiSessionInfoSchema = z.object({ name: z.string().optional() });

/** Extension `setTitle(title)`: the renderer shows it as the window title. */
export const PiTitleSchema = z.object({ title: z.string() });

/** A toolbar action or suggestion pill an extension registered over pi's event bus; reduced by `id` on the renderer's side. */
export const PiComposerSchema = ComposerRegistrationSchema;

/** Event name → value schema. The single registry both sides use. */
export const PI_CUSTOM_EVENTS = {
  'pi.compaction': PiCompactionSchema,
  'pi.queue': PiQueueSchema,
  'pi.retry': PiRetrySchema,
  'pi.model': PiModelSchema,
  'pi.tree': PiTreeSchema,
  'pi.status': PiStatusSchema,
  'pi.notify': PiNotifySchema,
  'pi.usage': PiUsageSchema,
  'pi.session_info': PiSessionInfoSchema,
  'pi.title': PiTitleSchema,
  'pi.composer': PiComposerSchema,
} as const;

export type PiCustomEventName = keyof typeof PI_CUSTOM_EVENTS;
export type PiCustomEventValue<N extends PiCustomEventName> = z.infer<(typeof PI_CUSTOM_EVENTS)[N]>;

/** A `CUSTOM` event body for one of the pi signals. */
export type PiCustomEvent = {
  [N in PiCustomEventName]: { name: N; value: PiCustomEventValue<N> };
}[PiCustomEventName];

export function isPiCustomEventName(name: string): name is PiCustomEventName {
  return Object.prototype.hasOwnProperty.call(PI_CUSTOM_EVENTS, name);
}

/** Parses the `name`/`value` of an AG-UI `CUSTOM` event; `undefined` when it is not a valid pi signal. */
export function parsePiCustomEvent(event: { name: string; value: unknown }): PiCustomEvent | undefined {
  if (!isPiCustomEventName(event.name)) return undefined;
  const parsed = PI_CUSTOM_EVENTS[event.name].safeParse(event.value);
  return parsed.success ? ({ name: event.name, value: parsed.data } as PiCustomEvent) : undefined;
}
