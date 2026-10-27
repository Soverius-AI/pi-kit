import { type CallHandler, type ExecutionContext, Inject, Injectable, Logger, type NestInterceptor, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';
import { CONFIG } from '../app/config.token';
import type { BackendConfig } from '../app/config';
import { issueMessages } from './pipe';
import { RESPONSE_SCHEMA } from './responds';

/**
 * The global response check. A handler marked with `@Responds` has its result parsed with the schema of its answer, so the
 * answer carries exactly what the schema names. A result that does not match is a bug in the backend, never the caller's: in development
 * (`dev:web`, the tests) it is logged and answered with a 500, so the drift is seen the day it is made; in production it is logged and the
 * result goes out as it is, because a response that is a little off is better for the person than one that is not there at all.
 *
 * The log names the route and the paths of the problems, not the values.
 */
@Injectable()
export class ContractSerializerInterceptor implements NestInterceptor {
  private readonly log = new Logger('Contract');

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: BackendConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<z.ZodType | undefined>(RESPONSE_SCHEMA, context.getHandler());
    if (!schema) return next.handle();
    return next.handle().pipe(
      map((value) => {
        const result = schema.safeParse(value);
        if (result.success) return result.data;
        const request = context.switchToHttp().getRequest<{ method?: string; url?: string }>();
        this.log.error(`${request.method} ${request.url}: the response does not match its schema: ${issueMessages(result.error.issues).join('; ')}`);
        if (this.config.dev) throw new InternalServerErrorException();
        return value;
      }),
    );
  }
}
