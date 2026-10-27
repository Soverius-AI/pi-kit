import { Logger } from '@nestjs/common';
import type { ProviderUsage } from '@pi-kit/protocol';
import { type Fetcher, USAGE_ADAPTERS, type UsageAdapter } from './usage-adapters';

/** Ordinary reads, null included, are cached for a minute; explicit refreshes reconcile spending and top-ups sooner. */
export const USAGE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

/** The token a usage source needs, and which sign-in it came from. */
export interface UsageCredential {
  type: 'oauth' | 'api_key';
  token: string;
}

/** Where the credential comes from; `PiConfigService` in the app, a stub in tests. */
export interface UsageCredentials {
  usageCredential(provider: string): Promise<UsageCredential | undefined>;
}

interface UsageOptions {
  now?: () => number;
  fetcher?: Fetcher;
  adapters?: readonly UsageAdapter[];
}

/**
 * `GET /api/providers/:id/usage`: finds the adapter for the provider and its sign-in, caches ordinary reads and remembers the answer (also a `null`). A token or key is read for the call and
 * never kept, logged or put in an error; a failure is logged as the provider and the class of the failure only.
 */
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  private readonly cache = new Map<string, { at: number; value: ProviderUsage | null }>();
  private readonly inflight = new Map<string, Promise<ProviderUsage | null>>();
  private readonly now: () => number;
  private readonly fetcher: Fetcher;
  private readonly adapters: readonly UsageAdapter[];

  constructor(
    private readonly credentials: UsageCredentials,
    options: UsageOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.adapters = options.adapters ?? USAGE_ADAPTERS;
  }

  async usage(provider: string, refresh = false): Promise<ProviderUsage | null> {
    const running = this.inflight.get(provider);
    if (running) return running;
    const hit = this.cache.get(provider);
    if (!refresh && hit && this.now() - hit.at < USAGE_TTL_MS) return hit.value;
    const run = this.ask(provider).then((value) => {
      this.cache.set(provider, { at: this.now(), value });
      return value;
    });
    this.inflight.set(provider, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(provider);
    }
  }

  private async ask(provider: string): Promise<ProviderUsage | null> {
    const adapter = this.adapters.find((a) => a.providers.includes(provider));
    if (!adapter) return null;
    try {
      const credential = await this.credentials.usageCredential(provider);
      if (!credential || (adapter.credential !== 'either' && credential.type !== adapter.credential)) return null;
      return await adapter.fetch(credential.token, this.fetcher, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (error) {
      // The reason is a class of failure (a timeout, a refused connection), never the request: nothing here can hold the token.
      this.logger.warn(`No usage from ${provider}: ${error instanceof Error ? error.name : 'failed'}`);
      return null;
    }
  }
}
