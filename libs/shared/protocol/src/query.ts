import { z } from 'zod';

/**
 * The query parameters several routes share. A query arrives as text, so a flag is `0`, `1`, `true` or `false` and a number is coerced; the
 * schema is the one place that says so, and a value it does not know is a 400 instead of a silent "off".
 */

/** A switch in a query string: `?ignored=1`. */
export const QueryFlagSchema = z.enum(['0', '1', 'true', 'false']);
export type QueryFlag = z.infer<typeof QueryFlagSchema>;

/** Whether a `QueryFlagSchema` value (or none) is on. */
export const flagOn = (flag: QueryFlag | undefined): boolean => flag === '1' || flag === 'true';

/** `?thread=`: the thread whose pi session an action applies to; a call without it only reads configuration. */
export const OptionalThreadQuerySchema = z.object({ thread: z.string().optional() });

/** `?thread=`: an action that needs the thread's pi session. */
export const ThreadQuerySchema = z.object({ thread: z.string().min(1) });

/** `?cwd=`: the project folder a setting is read for (the default folder of the backend when it is missing or does not exist). */
export const CwdQuerySchema = z.object({ cwd: z.string().optional() });
