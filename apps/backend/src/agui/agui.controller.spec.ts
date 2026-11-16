import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AguiController } from './agui.controller';
import type { AguiService } from './agui.service';

// The bridge owns HTTP streams, not the runtime's models, database or agent processes.
vi.mock('./agui.service', () => ({ AguiService: class {} }));

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

async function bridge(handle: AguiService['handle']) {
  const controller = new AguiController({ handle } as AguiService);
  const app = express();
  const failures: unknown[] = [];
  const finished = vi.fn();
  app.use(express.json());
  app.use('/api/copilotkit', (req, res) => {
    void controller.handle(req, res).then(finished, (error: unknown) => {
      failures.push(error);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copilotkit/agent/pi/connect`;
  return { url, failures, finished };
}

const chunk = new TextEncoder().encode('data: {"type":"RUN_STARTED"}\n\n');

describe('AG-UI HTTP stream bridge', () => {
  it('streams the response and preserves the parsed request without aborting a normal completion', async () => {
    let request: Request | undefined;
    let body: unknown;
    const { url, failures, finished } = await bridge(async (incoming) => {
      request = incoming;
      body = await incoming.json();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 201, headers: { 'Content-Type': 'text/event-stream', 'X-Bridge-Test': 'yes' } },
      );
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Request': 'yes' },
      body: JSON.stringify({ threadId: 'one' }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-bridge-test')).toBe('yes');
    expect(await response.text()).toBe(new TextDecoder().decode(chunk));
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(request?.url).toBe(url);
    expect(request?.headers.get('content-length')).toBeNull();
    expect(request?.headers.get('x-test-request')).toBe('yes');
    expect(body).toEqual({ threadId: 'one' });
    expect(request?.signal.aborted).toBe(false);
    expect(failures).toEqual([]);
  });

  it('ends responses without a body without aborting them', async () => {
    let request: Request | undefined;
    const { url, failures, finished } = await bridge(async (incoming) => {
      request = incoming;
      return new Response(null, { status: 204 });
    });
    const response = await fetch(url);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(request?.signal.aborted).toBe(false);
    expect(failures).toEqual([]);
  });

  it.each([false, true])(
    'cancels the old replay on a thread switch (runtime errors on abort: %s)',
    async (errorsOnAbort) => {
      const cancel = vi.fn();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      let request: Request | undefined;
      const { url, failures, finished } = await bridge(async (incoming) => {
        request = incoming;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              if (errorsOnAbort)
                incoming.signal.addEventListener('abort', () => controller.error(incoming.signal.reason));
            },
            cancel,
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      });
      const abort = new AbortController();
      const response = await fetch(url, { signal: abort.signal });
      await response.body!.getReader().read();
      abort.abort();
      await vi.waitFor(() => {
        expect(request?.signal.aborted).toBe(true);
        expect(finished).toHaveBeenCalledOnce();
        if (!errorsOnAbort) expect(cancel).toHaveBeenCalledOnce();
      });
      expect(failures).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'cancels a response arriving after the client switched away (cancel rejects: %s)',
    async (cancelRejects) => {
      let respond!: (response: Response) => void;
      let request: Request | undefined;
      const cancel = vi.fn(() => (cancelRejects ? Promise.reject(new Error('already closed')) : undefined));
      const { url, failures, finished } = await bridge(
        (incoming) =>
          new Promise<Response>((resolve) => {
            request = incoming;
            respond = resolve;
          }),
      );
      const abort = new AbortController();
      const pending = fetch(url, { signal: abort.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(request).toBeDefined());
      abort.abort();
      await pending;
      await vi.waitFor(() => expect(request?.signal.aborted).toBe(true));
      respond(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => {
        expect(cancel).toHaveBeenCalledOnce();
        expect(finished).toHaveBeenCalledOnce();
      });
      expect(failures).toEqual([]);
    },
  );

  it('contains a runtime rejection after the client disconnected before any headers', async () => {
    let request: Request | undefined;
    const { url, failures, finished } = await bridge(
      (incoming) =>
        new Promise<Response>((_resolve, reject) => {
          request = incoming;
          incoming.signal.addEventListener('abort', () => reject(incoming.signal.reason));
        }),
    );
    const abort = new AbortController();
    const pending = fetch(url, { signal: abort.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(request).toBeDefined());
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(failures).toEqual([]);
  });

  it('contains a response-body error to this client rather than emitting an unhandled stream error', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { url, failures, finished } = await bridge(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              source = controller;
              controller.enqueue(chunk);
            },
          }),
        ),
    );
    const response = await fetch(url);
    const reader = response.body!.getReader();
    await reader.read();
    const failed = reader.read().catch((error: unknown) => error);
    source.error(new Error('replay body failed'));
    expect(await failed).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(failures).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replay body failed'));
  });

  it('leaves failures before headers to Nest’s exception handler', async () => {
    const failure = new Error('runtime handler failed');
    const { url, failures } = await bridge(async () => {
      throw failure;
    });
    expect((await fetch(url)).status).toBe(500);
    expect(failures).toEqual([failure]);
  });
});
