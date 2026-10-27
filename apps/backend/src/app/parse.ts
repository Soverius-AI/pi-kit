import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a request body with one of the `@pi-kit/protocol` schemas; a failure is a 400 that says which field. */
export function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new BadRequestException(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  return result.data;
}
