import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SettingsSlices {
  private readonly last = new Map<string, unknown>();
  private readonly shared = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.last.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.last.set(key, value);
  }

  share<T>(key: string, create: () => T): T {
    if (!this.shared.has(key)) this.shared.set(key, create());
    return this.shared.get(key) as T;
  }
}
