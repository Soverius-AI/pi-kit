import { Injectable, inject } from '@angular/core';
import { BackendService } from './backend.service';
import { createTypedClient, problemText, type TypedClient } from './typed-client';

/**
 * Requests to the backend with the bearer token. `client` is the typed client of the generated contract: stores call generated operations directly with it and `unwrap` the answer. `stream` handles NDJSON framing and lifecycle explicitly.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly backend = inject(BackendService);

  /** Pass this authenticated instance to generated operation functions. */
  readonly client: TypedClient = createTypedClient((path, init) => this.backend.fetch(path, init));

  /**
   * A newline-delimited JSON stream (`!command`, the terminal, a provider sign-in): calls `onLine` for every parsed line
   * until the server ends the response or its signal aborts it. The generated operation must use `parseAs: 'stream'`; it owns the route, parameters and cancellation.
   */
  async stream<T>(
    request: Promise<{ response?: Response; error?: unknown }>,
    onLine: (line: T) => void,
  ): Promise<void> {
    const result = await request;
    const res = result.response;
    if (!res?.ok) throw new Error(problemText(result.error, res));
    if (!res.body) throw new Error('The backend returned an empty stream.');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += value;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onLine(JSON.parse(line) as T);
          newline = buffer.indexOf('\n');
        }
        if (done) {
          if (buffer.trim()) onLine(JSON.parse(buffer) as T);
          return;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export async function failureText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    return [body.message].flat().join(', ') || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
