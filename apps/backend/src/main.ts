import './app/telemetry-off';
import './app/fatal-diagnostics';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app/app.module';
import { configureJsonBody } from './app/http-body';
import { loadConfig } from './app/config';
import { mountContract } from './contract';
import { REPLAY_CURSOR_HEADER, THREAD_HYDRATION_HEADER } from '@pi-kit/protocol';

/**
 * Development and tests only: `PI_KIT_HOME` is the home folder pi reads (it lists the skills of `~/.agents/skills` besides its own folder), so a scratch world is all its lists show and the
 * screenshots carry nothing of whoever takes them. It is a variable of the backend alone (the tools that start it keep the real home), and it is ignored in production builds.
 */
function scratchHome(env: NodeJS.ProcessEnv = process.env): void {
  if (env['NODE_ENV'] !== 'production' && env['PI_KIT_HOME']) env['HOME'] = env['PI_KIT_HOME'];
}

async function bootstrap() {
  scratchHome();
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureJsonBody(app);
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.origins, allowedHeaders: ['Authorization', 'Content-Type', REPLAY_CURSOR_HEADER, THREAD_HYDRATION_HEADER] });
  // The contract: the OpenAPI document at GET /api/openapi.json behind the token; the Swagger UI only for dev:web.
  mountContract(app, { ui: config.dev });
  await app.listen(config.port, config.host);
  Logger.log(`pi-kit backend listening on http://${config.host}:${config.port}/api`);
}

void bootstrap().catch((error: unknown) => { Logger.error(error); process.exitCode = 1; });
