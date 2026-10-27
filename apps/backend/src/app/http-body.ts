import type { NestExpressApplication } from '@nestjs/platform-express';

/** Chat runs carry transcript history and inline images; their JSON body has no application size cap. */
export function configureJsonBody(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: Infinity });
}
