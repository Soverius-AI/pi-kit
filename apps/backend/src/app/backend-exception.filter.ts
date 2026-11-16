import { type ArgumentsHost, Catch, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';

/** Add request context to unexpected failures, without changing Nest's responses or treating them as process crashes. */
@Catch()
@Injectable()
export class BackendExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(BackendExceptionFilter.name);

  constructor(@Inject(HttpAdapterHost) adapter: HttpAdapterHost) {
    super(adapter.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    try {
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : this.isHttpError(exception)
            ? exception.statusCode
            : 500;
      if (status >= 500) {
        const request = host.switchToHttp().getRequest<Request>();
        // Prefer the matched route template: no query strings, authorization headers, bodies or dynamic parameter values.
        const route =
          typeof request.route?.path === 'string'
            ? `${request.baseUrl ?? ''}${request.route.path}`
            : request.path || '(unknown route)';
        const error = exception instanceof Error ? exception : undefined;
        const system = error as NodeJS.ErrnoException | undefined;
        const record = {
          event: 'HTTP_ERROR',
          at: new Date().toISOString(),
          pid: process.pid,
          method: request.method,
          route,
          status,
          error: error?.name ?? 'NonErrorException',
          message: error?.message ?? (typeof exception === 'string' ? exception : 'A non-Error value was thrown.'),
          ...(typeof system?.code === 'string' ? { code: system.code } : {}),
          ...(typeof system?.errno === 'number' ? { errno: system.errno } : {}),
          ...(typeof system?.syscall === 'string' ? { syscall: system.syscall } : {}),
        };
        // The service host persists stderr to backend.log. Keep Nest's default logging as well as its response handling.
        this.logger.error(JSON.stringify(record), error?.stack);
      }
    } catch {
      // A diagnostic must never prevent Nest from completing the original error response.
    }
    super.catch(exception, host);
  }
}
