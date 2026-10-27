import { TestBed } from '@angular/core/testing';
import { updateEvents } from '../generated/sdk.gen';
import { ApiClient } from './api-client';
import { BackendService } from './backend.service';

function setup(answer: () => Response) {
  const fetch = vi.fn(async () => answer());
  TestBed.configureTestingModule({ providers: [{ provide: BackendService, useValue: { fetch } }] });
  return { api: TestBed.inject(ApiClient), fetch };
}

describe('generated NDJSON transport', () => {
  it('uses the generated route and preserves split UTF-8 and a final frame without a newline', async () => {
    const events = [
      { type: 'line', text: 'Grüße', at: 1 },
      { type: 'line', text: 'done', at: 2 },
    ];
    const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join('\n'));
    const { api, fetch } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
    );
    const seen: unknown[] = [];
    await api.stream(updateEvents({ client: api.client, parseAs: 'stream' }), (event) => seen.push(event));
    expect(seen).toEqual(events);
    expect(fetch).toHaveBeenCalledWith('/api/update/events', expect.objectContaining({ method: 'GET' }));
  });

  it('cancels the reader when a consumer fails', async () => {
    const cancel = vi.fn();
    const { api } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"type":"line"}\n'));
            },
            cancel,
          }),
        ),
    );
    await expect(
      api.stream(updateEvents({ client: api.client, parseAs: 'stream' }), () => {
        throw new Error('consumer failed');
      }),
    ).rejects.toThrow('consumer failed');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves the backend Problem message for refused streams', async () => {
    const { api } = setup(
      () =>
        new Response(JSON.stringify({ message: 'Sign in again.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(api.stream(updateEvents({ client: api.client, parseAs: 'stream' }), () => undefined)).rejects.toThrow(
      'Sign in again.',
    );
  });
});
