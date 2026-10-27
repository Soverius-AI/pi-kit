import { ApiClient } from '../lib/api-client';
import { createTypedClient, type BackendFetch, type TypedClient } from '../lib/typed-client';

/** One request as it reached the backend: what generated-operation contract tests assert on. */
export interface RecordedCall {
  method: string;
  /** The path and the query as sent, e.g. `/api/threads?workspace=%2Fp&archived=1`. */
  path: string;
  /** The parsed JSON body; `undefined` without one. */
  body: unknown;
  headers: Headers;
}

/**
 * A stand-in for the backend for generated-operation contract tests. It sits where `BackendService.fetch` sits, so the whole typed client runs for real
 * (path and query serialisation, the JSON body, the error text) and a spec asserts on the wire request instead of on a mock of the class under test:
 *
 *   const backend = fakeBackend();
 *   TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: backend.apiClient }] });
 *   backend.reply({ queued: 2 });
 *   await unwrap(attendantRun({ client: TestBed.inject(ApiClient).client, body: { threadId: 't1' } }));
 *   expect(backend.calls[0]).toMatchObject({ method: 'POST', path: '/api/attendant/run', body: { threadId: 't1' } });
 *
 * Each `reply` answers the next call (200 with a JSON body, or the status you give, 204 without a body); a call nobody replied to answers 204.
 */
export function fakeBackend() {
  const calls: RecordedCall[] = [];
  const replies: { status: number; body: unknown }[] = [];

  const fetch: BackendFetch = async (path, init = {}) => {
    const raw =
      init.body === undefined || init.body === null ? undefined : new TextDecoder().decode(init.body as ArrayBuffer);
    calls.push({
      method: init.method ?? 'GET',
      path,
      body: raw
        ? new Headers(init.headers).get('content-type')?.includes('json')
          ? JSON.parse(raw)
          : new Uint8Array(init.body as ArrayBuffer)
        : undefined,
      headers: new Headers(init.headers),
    });
    const { status, body } = replies.shift() ?? { status: 204, body: undefined };
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    });
  };

  const client: TypedClient = createTypedClient(fetch);
  return {
    calls,
    /** Answers the next call. */
    reply(body?: unknown, status = body === undefined ? 204 : 200): void {
      replies.push({ status, body });
    },
    /** An error answer in Nest's shape: `{ statusCode, message }`. */
    fail(status: number, message: string | string[]): void {
      replies.push({ status, body: { statusCode: status, message } });
    },
    client,
    /** What to provide for `ApiClient`: the typed client and the shared NDJSON framer. */
    apiClient: { client, stream: ApiClient.prototype.stream },
  };
}
