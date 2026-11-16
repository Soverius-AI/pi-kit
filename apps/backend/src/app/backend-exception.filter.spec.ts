import 'reflect-metadata';
import { BadRequestException, Controller, Get, HttpException, Logger, Post, Res } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendExceptionFilter } from './backend-exception.filter';

@Controller('diagnostics')
class FailingController {
  @Post('failure/:id')
  failure(): never {
    throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL', errno: -4071, syscall: 'spawn' });
  }

  @Get('async')
  async rejected(): Promise<void> {
    await Promise.resolve();
    throw new Error('async failure marker');
  }

  @Get('expected')
  expected(): never {
    throw new BadRequestException('Expected validation failure');
  }

  @Get('unavailable')
  unavailable(): never {
    throw new HttpException({ message: 'Unavailable', detail: 'Try later' }, 503);
  }

  @Get('primitive')
  primitive(): never {
    throw 'primitive failure marker';
  }

  @Get('sent')
  sent(@Res() response: Response): never {
    response.json({ alreadySent: true });
    throw new Error('stream failed after headers');
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function start() {
  const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const module = await Test.createTestingModule({
    controllers: [FailingController],
    providers: [{ provide: APP_FILTER, useClass: BackendExceptionFilter }],
  }).compile();
  app = module.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const records = () =>
    errors.mock.calls
      .filter(([message]) => typeof message === 'string' && message.startsWith('{"event":"HTTP_ERROR"'))
      .map(([message]) => JSON.parse(message as string));
  return { url, errors, records };
}

describe('global backend exception diagnostics', () => {
  it('logs route, process, stack and OS error details without changing the normal 500 response', async () => {
    const { url, errors, records } = await start();
    const response = await fetch(`${url}/api/diagnostics/failure/private-thread-id?token=private-query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer private-header', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'private-body', message: 'private-prompt' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(records()).toEqual([
      expect.objectContaining({
        event: 'HTTP_ERROR',
        at: expect.any(String),
        pid: process.pid,
        method: 'POST',
        route: '/api/diagnostics/failure/:id',
        status: 500,
        error: 'Error',
        message: 'spawn EINVAL',
        code: 'EINVAL',
        errno: -4071,
        syscall: 'spawn',
      }),
    ]);
    const record = errors.mock.calls.find(([message]) => typeof message === 'string' && message.includes('HTTP_ERROR'));
    expect(record?.[1]).toContain('Error: spawn EINVAL');
    expect(record?.[1]).toContain('FailingController.failure');
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(
      /private-thread-id|private-query|private-header|private-body|private-prompt/,
    );
  });

  it('also records rejected controller promises', async () => {
    const { url, records } = await start();
    expect((await fetch(`${url}/api/diagnostics/async`)).status).toBe(500);
    expect(records()).toEqual([expect.objectContaining({ message: 'async failure marker', status: 500 })]);
  });

  it('leaves normal client errors unchanged without adding crash-like diagnostics', async () => {
    const { url, records } = await start();
    const response = await fetch(`${url}/api/diagnostics/expected`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Expected validation failure', statusCode: 400 });
    expect(records()).toEqual([]);
  });

  it('logs explicit server exceptions while preserving their status and response body', async () => {
    const { url, records } = await start();
    const response = await fetch(`${url}/api/diagnostics/unavailable`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'Unavailable', detail: 'Try later' });
    expect(records()).toEqual([expect.objectContaining({ status: 503, message: 'Unavailable' })]);
  });

  it('handles non-Error throws without allowing them into the client response', async () => {
    const { url, records } = await start();
    const response = await fetch(`${url}/api/diagnostics/primitive`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(records()).toEqual([
      expect.objectContaining({ error: 'NonErrorException', message: 'primitive failure marker' }),
    ]);
  });

  it('does not try to replace a response whose headers were already sent', async () => {
    const { url, records } = await start();
    const response = await fetch(`${url}/api/diagnostics/sent`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ alreadySent: true });
    expect(records()).toEqual([expect.objectContaining({ message: 'stream failed after headers' })]);
    expect((await fetch(`${url}/api/diagnostics/expected`)).status).toBe(400);
  });

  it('does not let a diagnostic failure prevent Nest from sending the error response', async () => {
    const { url, errors } = await start();
    errors.mockImplementation(() => {
      throw new Error('diagnostic unavailable');
    });
    const response = await fetch(`${url}/api/diagnostics/unavailable`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'Unavailable', detail: 'Try later' });
  });
});
