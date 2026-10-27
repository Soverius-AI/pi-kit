import { z } from 'zod';

/**
 * The body of every error the backend answers with (Nest's exception filter): the status, what went wrong and the status text. A request that
 * fails validation has one `path: reason` per problem in `message` (an array); every other error has a sentence.
 */
export const ProblemSchema = z
  .object({
    statusCode: z.number().int(),
    message: z.union([z.string(), z.array(z.string())]),
    error: z.string().optional(),
  })
  .meta({ id: 'Problem' });
export type Problem = z.infer<typeof ProblemSchema>;
