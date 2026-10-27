import { type ArgumentMetadata, BadRequestException, Injectable, Logger, StandardSchemaValidationPipe } from '@nestjs/common';
import { redactSecrets } from '@pi-kit/protocol';

/** One `path: reason` per problem, the message `parse()` always answered a bad body with (the renderer shows it as it is). */
export function issueMessages(issues: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string }[]): string[] {
  return issues.map((issue) => {
    const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
    return `${path || 'body'}: ${issue.message}`;
  });
}

/**
 * The global validation pipe: a parameter that names a schema (`@Body({ schema })`, `@Query({ schema })`) is parsed with it, so the
 * handler receives the parsed value (defaults applied, unknown keys of a non-strict object dropped); a parameter without one passes through. A
 * rejected request is a 400 whose `message` lists the zod paths.
 *
 * A body that is missing counts as `{}` where a schema is named, as it always did (`parse(schema, body ?? {})`), so an action without a payload (`POST .../abort`) needs none; a body without a schema is left alone.
 *
 * The log line of a rejection names the schema's paths and reasons, never the values: and where it prints the rejected value at the debug level, a field
 * that the schema marks with `.meta({ secret: true })` is replaced, and so is everything the schema does not describe when it holds a mark.
 */
@Injectable()
export class ContractValidationPipe extends StandardSchemaValidationPipe {
  private readonly log = new Logger('Contract');

  constructor() {
    super({ exceptionFactory: (issues) => new BadRequestException(issueMessages(issues)) });
  }

  override async transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
    const input = (metadata.schema && metadata.type === 'body' && (value === undefined || value === null) ? {} : value) as T;
    try {
      return await super.transform(input, metadata);
    } catch (error) {
      if (error instanceof BadRequestException && metadata.schema) {
        const detail = (error.getResponse() as { message?: string[] }).message ?? [];
        this.log.warn(`Rejected ${metadata.type}: ${detail.join('; ')}`);
        this.log.debug(`Rejected ${metadata.type}: ${JSON.stringify(redactSecrets(metadata.schema, input))}`);
      }
      throw error;
    }
  }
}
