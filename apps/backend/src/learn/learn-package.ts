import { Injectable } from '@nestjs/common';
import type { ThreadTranscript } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { PiKitPackage } from '../plugins/pi-kit-package';

export const LEARN_PACKAGE = '@pi-kit/learn';

/** What `packages/pi-kit-learn/lib/analysis.mjs` offers pi-kit's backend (the extension uses the same file). */
export interface AnalysisModule {
  buildAnalysisPrompt(transcript: ThreadTranscript): { system: string; user: string };
  parseDraftReply(reply: string): { ok: true; name: string; description: string; text: string } | { ok: false; skip?: boolean; reason: string };
}

/**
 * The `@pi-kit/learn` package as pi-kit sees it: installed into pi's settings once, and its analysis module for the drafts the attendant makes. The install
 * logic is `PiKitPackage`'s, shared with `@pi-kit/meat-proxy` and `@pi-kit/computer-use`. `PI_KIT_LEARN_PACKAGE=off` skips the install.
 */
@Injectable()
export class LearnPackage extends PiKitPackage<AnalysisModule> {
  constructor(meta: MetaRepository) {
    super(meta, { name: LEARN_PACKAGE, folder: 'pi-kit-learn', entry: 'lib/analysis.mjs', setting: 'learn', env: 'PI_KIT_LEARN_PACKAGE', label: 'learn' });
  }

  /** The analysis module of the installed package, or `undefined` when pi has none (removed, or never installed): then nothing is drafted. */
  analysis(): Promise<AnalysisModule | undefined> {
    return this.load();
  }
}
