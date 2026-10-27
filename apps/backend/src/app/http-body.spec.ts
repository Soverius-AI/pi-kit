import 'reflect-metadata';
import { Body, Controller, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { configureJsonBody } from './http-body';

@Controller('api/copilotkit/agent/pi')
class ChatBodyController {
  @Post('run')
  run(@Body() body: { messages: { content: string }[] }): { length: number } {
    return { length: body.messages[0].content.length };
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<string> {
  const module = await Test.createTestingModule({ controllers: [ChatBodyController] }).compile();
  app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureJsonBody(app);
  await app.listen(0, '127.0.0.1');
  return app.getUrl();
}

describe('chat JSON request bodies', () => {
  it.each([588_607, 24 * 1024 * 1024])('accepts a %i-byte message in an existing thread', async (length) => {
    const url = await start();
    const response = await fetch(`${url}/api/copilotkit/agent/pi/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'existing-thread', messages: [{ role: 'user', content: 'x'.repeat(length) }] }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ length });
  });

  it('still rejects malformed JSON', async () => {
    const url = await start();
    const response = await fetch(`${url}/api/copilotkit/agent/pi/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"messages":',
    });
    expect(response.status).toBe(400);
  });
});
