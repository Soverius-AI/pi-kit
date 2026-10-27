import './openapi-env';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { createContractDocument, documentToYaml } from './contract';

/**
 * Writes the OpenAPI document of the backend as YAML: `node dist/apps/backend/openapi.js <file>` (`pnpm run api:openapi`).
 *
 * The application is scanned, not started: `preview` builds the module graph without creating a provider, so nothing opens the database, the
 * keychain or pi's folder, and nothing listens. The document comes from the same `createContractDocument` the running backend serves.
 */
async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: node openapi.js <output file>');
  const app = await NestFactory.create(AppModule, { preview: true, abortOnError: false, logger: false });
  app.setGlobalPrefix('api');
  writeFileSync(out, documentToYaml(createContractDocument(app)));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
