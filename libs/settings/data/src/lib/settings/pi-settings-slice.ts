import { computed, signal } from '@angular/core';
import type { PatchPiSettings, PiSettings } from '@pi-kit/protocol';

export class PiSettingsSlice {
  readonly confirmed = signal<PiSettings | undefined>(undefined);
  readonly edits = signal<ReadonlyMap<number, PatchPiSettings>>(new Map());
  readonly settings = computed(() => {
    let settings = this.confirmed();
    if (!settings) return undefined;
    for (const { defaultModel, ...plain } of this.edits().values())
      settings = {
        ...settings,
        ...plain,
        ...(defaultModel ? { defaultProvider: defaultModel.provider, defaultModel: defaultModel.modelId } : {}),
      };
    return settings;
  });
  revision = 0;
  mutations: Promise<unknown> = Promise.resolve();

  edit(version: number, patch: PatchPiSettings): void {
    this.edits.update((edits) => new Map(edits).set(version, patch));
  }

  settle(version: number): void {
    this.edits.update((edits) => {
      const next = new Map(edits);
      next.delete(version);
      return next;
    });
  }
}
