import type { Provider } from '@angular/core';
import { ApiClient } from '../lib/api-client';
import { BackendService } from '../lib/backend.service';
import type { TypedClient } from '../lib/typed-client';

type Operation = (options: never) => unknown;
type Reply = (...args: never[]) => unknown;
export interface MockRequest {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}
export type OperationMock = readonly [
  Operation,
  Reply,
  (options: MockRequest) => unknown[] | Promise<unknown[]>,
  ((data: unknown) => unknown)?,
  ((options: MockRequest) => boolean)?,
];
export type StreamMock = readonly [
  RegExp,
  Reply,
  (path: string, onLine: (data: unknown) => void, signal?: AbortSignal, init?: RequestInit) => unknown[],
];
export type RequestMock = readonly [RegExp, Reply, (path: string, body: Record<string, unknown>) => unknown[]];

/** Unit-test transport: generated operations still execute, while tests control their replies and cancellation. */
export function provideMockApi(
  operations: OperationMock[],
  streams: StreamMock[] = [],
  requests: RequestMock[] = [],
): Provider[] {
  const routes = new Map<string, OperationMock[]>();
  const response = (data?: unknown) => ({
    data,
    response: new Response(null, { status: data === undefined ? 204 : 200 }),
  });
  const verbs = ['get', 'post', 'put', 'patch', 'delete'] as const;
  // Obtain route metadata from the generated operation without performing I/O.
  for (const mock of operations) {
    const probe = Object.fromEntries(
      verbs.map((verb) => [
        verb,
        (options: { url: string }) => {
          const key = `${verb}:${options.url}`;
          routes.set(key, [...(routes.get(key) ?? []), mock]);
          return Promise.resolve(response());
        },
      ]),
    );
    mock[0]({ client: probe } as never);
  }
  const client = Object.fromEntries(
    verbs.map((verb) => [
      verb,
      async (options: MockRequest & { url: string; parseAs?: string }) => {
        if (options.parseAs === 'stream') {
          const path = options.url.replace(/\{(\w+)\}/g, (_match, name: string) => {
            const value = options.path?.[name];
            if (value === undefined) throw new Error(`Missing mock path parameter: ${name}`);
            return encodeURIComponent(value);
          });
          let closed = false;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              void stream(
                path,
                (line) => {
                  if (!closed) controller.enqueue(new TextEncoder().encode(JSON.stringify(line) + '\n'));
                },
                options.signal,
                { body: JSON.stringify(options.body) },
              ).then(
                () => {
                  if (!closed) {
                    closed = true;
                    controller.close();
                  }
                },
                (error) => {
                  if (!closed) {
                    closed = true;
                    controller.error(error);
                  }
                },
              );
            },
            cancel() {
              closed = true;
            },
          });
          return { response: new Response(body), data: body };
        }
        const mock = routes
          .get(`${verb}:${options.url}`)
          ?.slice()
          .reverse()
          .find((binding) => !binding[4] || binding[4](options));
        if (!mock) throw new Error(`No test reply for ${verb.toUpperCase()} ${options.url}`);
        const args = mock[2](options);
        const pending = Array.isArray(args)
          ? mock[1](...(args as never[]))
          : args.then((values) => mock[1](...(values as never[])));
        const data = await pending;
        return response(mock[3] ? mock[3](data) : data);
      },
    ]),
  ) as unknown as TypedClient;
  const stream = async (path: string, onLine: (data: unknown) => void, signal?: AbortSignal, init?: RequestInit) => {
    const mock = streams.find(([pattern]) => pattern.test(path));
    if (!mock) throw new Error(`No test stream for ${path}`);
    const result = mock[1](...(mock[2](path, onLine, signal, init) as never[]));
    if (result && typeof result === 'object' && 'subscribe' in result) {
      await new Promise<void>((resolve, reject) => {
        const subscription = (
          result as {
            subscribe: (observer: { next: typeof onLine; error: typeof reject; complete: typeof resolve }) => {
              unsubscribe: () => void;
            };
          }
        ).subscribe({ next: onLine, error: reject, complete: resolve });
        signal?.addEventListener(
          'abort',
          () => {
            subscription.unsubscribe();
            resolve();
          },
          { once: true },
        );
      });
    } else await result;
  };
  client.sse = {
    get: async (options: { url: string; path: Record<string, string>; signal?: AbortSignal }) => {
      const values: unknown[] = [];
      let done = false;
      let failure: unknown;
      let wake: (() => void) | undefined;
      const close = () => {
        done = true;
        wake?.();
      };
      options.signal?.addEventListener('abort', close, { once: true });
      void stream(
        options.url.replace(/\{(\w+)\}/g, (_match, name: string) => encodeURIComponent(options.path[name])),
        (data) => {
          values.push(data);
          wake?.();
        },
        options.signal,
      ).then(close, (error) => {
        failure = error;
        close();
      });
      return {
        stream: (async function* () {
          try {
            while (!done || values.length) {
              if (values.length) yield values.shift();
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
            if (failure) throw failure;
          } finally {
            options.signal?.removeEventListener('abort', close);
          }
        })(),
      };
    },
  } as unknown as TypedClient['sse'];
  const backend = {
    fetch: async (path: string, init: RequestInit = {}) => {
      const mock = requests.find(([pattern]) => pattern.test(path));
      if (!mock) throw new Error(`No test request for ${path}`);
      await mock[1](...(mock[2](path, JSON.parse(String(init.body ?? '{}'))) as never[]));
      return new Response(null, { status: 200 });
    },
  };
  return [
    { provide: ApiClient, useValue: { client, stream: ApiClient.prototype.stream } },
    { provide: BackendService, useValue: backend },
  ];
}
