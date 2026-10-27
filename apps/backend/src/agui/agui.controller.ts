import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { All, Controller, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { AguiService } from './agui.service';

/**
 * Mounts CopilotKit's runtime at /api/copilotkit.
 *
 * A Nest controller adapts Express's `Request`/`Response` to the runtime's fetch handler, so it runs
 * behind the same global `BearerTokenGuard` and CORS setup as the rest of the API, on the same port.
 * Two details matter:
 *  - Nest has already parsed JSON bodies, so the body is serialised again for the fetch `Request`.
 *  - `/agent/:id/run` is an SSE stream: the response body is piped chunk by chunk (never buffered)
 *    and a closed socket aborts the fetch `Request`, which only unsubscribes this client: the run belongs to
 *    `PiAgentRunner` and goes on.
 */
@ApiExcludeController()
@Controller('copilotkit')
export class AguiController {
  constructor(private readonly agui: AguiService) {}

  @All(['', '*path'])
  async handle(@Req() req: ExpressRequest, @Res() res: ExpressResponse): Promise<void> {
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'content-length') continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;
    const request = new Request(`http://${req.headers.host}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: aborter.signal,
    });

    const response = await this.agui.handle(request);
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (!response.body) {
      res.end();
      return;
    }
    res.flushHeaders();
    Readable.fromWeb(response.body as unknown as WebReadableStream).pipe(res);
  }
}
