import { Injectable, inject, signal } from '@angular/core';
import { ApiClient, connectorsBrandLogos, unwrap } from '@pi-kit/api';

/** Colour brand logos by name, as data URLs. Each name is asked for once; names asked in the same tick go in one request. */
@Injectable({ providedIn: 'root' })
export class BrandLogosStore {
  private readonly api = inject(ApiClient);
  private readonly asked = new Set<string>();
  private pending: Promise<void> | undefined;
  private queued: string[] = [];
  readonly logos = signal<Record<string, string>>({});

  load(names: readonly string[]): Promise<void> {
    const missing = names.filter((name) => !this.asked.has(name));
    missing.forEach((name) => this.asked.add(name));
    this.queued.push(...missing);
    this.pending ??= Promise.resolve().then(() => this.flush());
    return this.pending;
  }

  private async flush(): Promise<void> {
    const names = this.queued;
    this.queued = [];
    this.pending = undefined;
    if (!names.length) return;
    const logos = await unwrap(
      connectorsBrandLogos({ client: this.api.client, query: { names: names.join(',') } }),
    ).catch(() => ({}) as Record<string, string>);
    this.logos.update((all) => ({ ...all, ...logos }));
  }
}
