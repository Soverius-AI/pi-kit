import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  BackendService,
  createTypedClient,
  fakeBackend,
  transcribeAbort,
  transcribeChunk,
  transcribeDownload,
  transcribeEnd,
  transcribeEvents,
  transcribeRecording,
  transcribeRemove,
  transcribeStartLive,
  transcribeStatus,
  unwrap,
} from '@pi-kit/api';

describe('generated operations', () => {
  let backend: ReturnType<typeof fakeBackend>;
  let api: ApiClient;
  beforeEach(() => {
    backend = fakeBackend();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: backend.apiClient },
        { provide: BackendService, useValue: { fetch: vi.fn() } },
      ],
    });
    api = TestBed.inject(ApiClient);
  });

  it('uses generated operations for model management and live session lifecycle', async () => {
    await unwrap(transcribeStatus({ client: api.client }));
    await unwrap(transcribeDownload({ client: api.client, body: { accept: true } }));
    await unwrap(transcribeRemove({ client: api.client }));
    backend.reply({ id: 'live 1/x' });
    expect(
      await unwrap(transcribeStartLive({ client: api.client, query: { language: 'en' }, signal: undefined })).then(
        ({ id }) => id,
      ),
    ).toBe('live 1/x');
    await unwrap(transcribeEnd({ client: api.client, path: { id: 'live 1/x' } }));
    await unwrap(transcribeAbort({ client: api.client, path: { id: 'live 1/x' } })).catch(() => undefined);
    expect(backend.calls).toMatchObject([
      { method: 'GET', path: '/api/transcribe/status' },
      { method: 'POST', path: '/api/transcribe/model', body: { accept: true } },
      { method: 'DELETE', path: '/api/transcribe/model' },
      { method: 'POST', path: '/api/transcribe/live?language=en' },
      { method: 'POST', path: '/api/transcribe/live/live%201%2Fx/end' },
      { method: 'DELETE', path: '/api/transcribe/live/live%201%2Fx' },
    ]);
  });

  it('sends WAV and PCM as raw bytes, including a view with a nonzero byte offset', async () => {
    const bytes = new Uint8Array([99, 1, 2, 3, 98]).subarray(1, 4);
    await unwrap(
      transcribeRecording({
        client: api.client,
        body: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }),
        query: { language: undefined },
        signal: undefined,
      }),
    );
    await unwrap(
      transcribeChunk({
        client: api.client,
        path: { id: 'live 1/x' },
        body: new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
      }),
    );
    expect(backend.calls[0].body).toEqual(new Uint8Array([1, 2, 3]));
    expect(backend.calls[0].headers.get('content-type')).toBe('audio/wav');
    expect(backend.calls[1]).toMatchObject({
      method: 'POST',
      path: '/api/transcribe/live/live%201%2Fx/chunk',
      body: new Uint8Array([1, 2, 3]),
    });
    expect(backend.calls[1].headers.get('content-type')).toBe('application/octet-stream');
  });

  it('propagates backend errors and keeps abort best-effort', async () => {
    backend.fail(409, 'Whistle is not downloaded.');
    await expect(
      unwrap(
        transcribeRecording({
          client: api.client,
          body: new Blob([new Uint8Array(new Uint8Array([1]))], { type: 'audio/wav' }),
          query: { language: 'en' },
          signal: undefined,
        }),
      ),
    ).rejects.toThrow('Whistle is not downloaded.');
    backend.fail(404, 'No such live session.');
    await expect(
      unwrap(transcribeAbort({ client: api.client, path: { id: 'gone' } })).catch(() => undefined),
    ).resolves.toBeUndefined();
  });

  it('parses split SSE frames and encodes the stream id', async () => {
    const fetch = vi.mocked(TestBed.inject(BackendService).fetch);
    fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"type":"partial","text":"hel'));
            controller.enqueue(encoder.encode('lo","pending":"","receivedSeconds":1}\n\n'));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();
    const { stream } = await transcribeEvents({
      client: createTypedClient(fetch),
      path: { id: 'live 1/x' },
      signal: abort.signal,
      sseMaxRetryAttempts: 1,
    });
    for await (const event of stream) onEvent(event);
    expect(fetch).toHaveBeenCalledWith(
      '/api/transcribe/live/live%201%2Fx/events',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onEvent).toHaveBeenCalledWith({ type: 'partial', text: 'hello', pending: '', receivedSeconds: 1 });
  });
});
