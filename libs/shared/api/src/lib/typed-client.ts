import { createClient, type Client } from '../generated/client';

export type TypedClient = Client;
export type BackendFetch = (path: string, init?: RequestInit) => Promise<Response>;

// The generated client builds Requests before the desktop port is known. Only
// the path/query are forwarded; BackendService owns the real origin and token.
const PLACEHOLDER_ORIGIN = 'http://backend.pi-kit.invalid';

export function createTypedClient(backend: BackendFetch): TypedClient {
  return createClient({
    baseUrl: PLACEHOLDER_ORIGIN,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      return backend(`${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body === null ? undefined : await request.arrayBuffer(),
        signal: request.signal,
      });
    },
  });
}

type Result<Data> = { data?: Data; error?: unknown; response?: Response };

export function problemText(error: unknown, response?: Response): string {
  if (error instanceof Error) return error.message;
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : typeof error === 'string'
        ? error
        : undefined;
  const text = [message]
    .flat()
    .filter((part) => typeof part === 'string' && part !== '')
    .join(', ');
  return text || (response ? `${response.status} ${response.statusText}` : 'The backend could not be reached.');
}

/** Preserve the backend's Problem message, including transport/network errors. */
export async function unwrap<Data>(call: Promise<Result<Data>>): Promise<Data> {
  const result = await call;
  if (result.error !== undefined || !result.response?.ok) throw new Error(problemText(result.error, result.response));
  return (result.response.status === 204 ? undefined : result.data) as Data;
}
