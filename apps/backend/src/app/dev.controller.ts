import { Controller, ForbiddenException, Get, Headers, Inject } from '@nestjs/common';
import { Public } from './auth.guard';
import { CONFIG } from './config.token';
import type { BackendConfig } from './config';

/**
 * Dev only (registered when NODE_ENV=development): hands the per-launch token to the renderer
 * running in a plain browser (`pnpm run dev:web`), which stores it in localStorage. The browser's
 * CORS check keeps other origins from reading the response; we also refuse unknown Origins.
 */
@Controller('dev')
export class DevController {
  constructor(@Inject(CONFIG) private readonly config: BackendConfig) {}

  @Public()
  @Get('token')
  token(@Headers('origin') origin: string | undefined): { token: string } {
    if (!origin || !this.config.origins.includes(origin)) throw new ForbiddenException();
    return { token: this.config.token };
  }
}
