import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { BackendService } from '@pi-kit/api';
import { PreviewUrlSchema, previewOrigins } from '@pi-kit/protocol';

export type PreviewBlock = 'pending' | 'invalid' | 'protected' | 'mixed' | 'unconfigured' | 'origin';
export type PreviewTarget = { url: string } | { blocked: PreviewBlock };

@Injectable({ providedIn: 'root' })
export class PreviewPolicy {
  private readonly document = inject(DOCUMENT);
  private readonly backend = inject(BackendService);
  private readonly backendOrigin = signal<string | undefined>(undefined);
  readonly ready = signal(false);
  readonly origins: readonly string[] = this.readOrigins();

  constructor() {
    void this.backend
      .url()
      .then((url) => {
        this.backendOrigin.set(new URL(url).origin);
        this.ready.set(true);
      })
      .catch(() => {
        this.ready.set(false);
      });
  }

  resolve(value: string): PreviewTarget {
    if (!this.ready()) return { blocked: 'pending' };
    const url = this.external(value);
    if (!url) return { blocked: PreviewUrlSchema.safeParse(value).success ? 'protected' : 'invalid' };
    const target = new URL(url);
    if (this.document.location.protocol === 'https:' && target.protocol !== 'https:') return { blocked: 'mixed' };
    if (!this.origins.length) return { blocked: 'unconfigured' };
    if (!this.origins.includes(target.origin)) return { blocked: 'origin' };
    return { url };
  }

  external(value: string): string | undefined {
    const parsed = PreviewUrlSchema.safeParse(value);
    if (!parsed.success || !this.ready()) return undefined;
    const url = new URL(parsed.data);
    if (url.origin === this.document.location.origin || url.origin === this.backendOrigin()) return undefined;
    if (
      this.document.querySelector('meta[name="pi-kit-connection"]')?.getAttribute('content') === 'device' &&
      url.hostname === this.document.location.hostname
    )
      return undefined;
    return url.href;
  }

  private readOrigins(): string[] {
    try {
      const value: unknown = JSON.parse(
        this.document.querySelector('meta[name="pi-kit-preview-origins"]')?.getAttribute('content') ?? '[]',
      );
      return Array.isArray(value) && value.every((origin) => typeof origin === 'string') ? previewOrigins(value) : [];
    } catch {
      return [];
    }
  }
}
