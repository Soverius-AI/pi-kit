import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiProduces, ApiResponse } from '@nestjs/swagger';
import { ProblemSchema } from '@pi-kit/protocol';
import { z } from 'zod';

/** The metadata key under which a handler keeps the schema of its answer, for the serializer. */
export const RESPONSE_SCHEMA = 'pi-kit:response-schema';

// Only `value` is looked at: the setter of a `TypedPropertyDescriptor` would make the check invariant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<R> = Pick<TypedPropertyDescriptor<(...args: any[]) => R | Promise<R>>, 'value'>;

interface RespondsOptions {
  /** The status the handler really sends: Nest answers a `POST` with 201 and everything else with 200 unless `@HttpCode` says otherwise. The spec of the contract compares the two. */
  status?: 200 | 201;
  description?: string;
}

const DESCRIPTION = { 200: 'OK', 201: 'Created' } as const;

/**
 * What a handler answers with, said once for the three readers of it: the OpenAPI document, the global serializer that parses the result
 * with the schema, and the compiler, which checks that the method returns what the schema describes.
 *
 *   @Responds(ThreadDetailSchema, { status: 201 })               // a POST that creates
 *   @Responds(ThreadSummarySchema, { array: true })              // a list
 *
 * A 204 has no body: use `@ApiNoContentResponse()` with `@HttpCode(204)`.
 */
export function Responds<S extends z.ZodType>(schema: S, options: RespondsOptions & { array: true }): (target: object, key: string | symbol, descriptor: Handler<z.input<S>[]>) => void;
export function Responds<S extends z.ZodType>(schema: S, options?: RespondsOptions & { array?: false }): (target: object, key: string | symbol, descriptor: Handler<z.input<S>>) => void;
export function Responds(schema: z.ZodType, options: RespondsOptions & { array?: boolean } = {}): MethodDecorator {
  const { status = 200, description = DESCRIPTION[status], array = false } = options;
  const type = array ? z.array(schema) : schema;
  return applyDecorators(ApiResponse({ status, description, standardSchema: type } as Parameters<typeof ApiResponse>[0]), SetMetadata(RESPONSE_SCHEMA, type));
}

/** The line schemas of the streams of the document, so that the document can list each as a component (see `Streams`). */
export const streamSchemas = new Set<z.ZodType>();

/**
 * A stream: newline-delimited JSON (`application/x-ndjson`, one JSON value per line) or server-sent events (`text/event-stream`, an `event:` and a
 * `data:` line per message). `line` describes one line or event and needs a `.meta({ id })`. OpenAPI has no way to say "a sequence of"; the response is a string whose
 * `x-line-schema` points at the component of one line, and the typed client leaves the streams to `ApiClient.stream`.
 */
export function Streams(line: z.ZodType, description: string, contentType: 'application/x-ndjson' | 'text/event-stream' = 'application/x-ndjson'): MethodDecorator {
  streamSchemas.add(line);
  const id = z.globalRegistry.get(line)?.id;
  if (!id) throw new Error('The line schema of a stream needs .meta({ id }).');
  const unit = contentType === 'text/event-stream' ? 'event' : 'line';
  return applyDecorators(
    ApiProduces(contentType),
    ApiResponse({
      status: 200,
      description,
      content: { [contentType]: { schema: { type: 'string', description: `One \`${id}\` per ${unit}.`, 'x-line-schema': { $ref: `#/components/schemas/${id}` } } as object } },
    }),
  );
}

/**
 * The errors a handler answers with, each with what it means here: `@Fails({ 404: 'There is no such thread.', 409: 'A run holds the thread.' })`. They are documented with the shared
 * `Problem` body. The 401 of the bearer token and the 400 of a request that names a schema are added to every operation by the document itself, so a handler lists a 400 only
 * when it throws one of its own (a value the schema cannot check).
 */
export function Fails(problems: Record<number, string>): MethodDecorator {
  return applyDecorators(...Object.entries(problems).map(([status, description]) => ApiResponse({ status: Number(status), description, standardSchema: ProblemSchema } as Parameters<typeof ApiResponse>[0])));
}
