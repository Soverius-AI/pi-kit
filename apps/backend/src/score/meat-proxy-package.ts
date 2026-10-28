import { Injectable } from '@nestjs/common';
import type { HunkLabelEntry, HunkLabelsStore, OutcomeScores } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { PiKitPackage } from '../plugins/pi-kit-package';

export const MEAT_PROXY_PACKAGE = '@pi-kit/meat-proxy';

/** A request the host could not answer: the code is one of `PluginFailureCode`. */
export interface HostFailure {
  ok: false;
  code: string;
  error: string;
  model?: string;
}

/** What the extension and the backend share: the whole scoring of a thread against a host that answers the plugin API's requests (`lib/pipeline.mjs`). */
export interface ScoringHost {
  outcome(): Promise<
    | { ok: true; outcome: unknown; diff?: string | null; annotations?: { hunkLabels: unknown; scores: unknown } }
    | HostFailure
  >;
  transcript(): Promise<{ ok: true; transcript: unknown } | HostFailure>;
  baselines(): Promise<{ ok: true; files: unknown[] } | HostFailure>;
  /** One model call; `progress` says which of the diff's batches this is (1-based), so a long scoring can be followed call by call. */
  run(
    prompt: { system: string; user: string },
    progress: { batch: number; batches: number },
  ): Promise<{ ok: true; text: string; model?: string | null } | HostFailure>;
  annotate(body: {
    base: string;
    head: string;
    model: string | null;
    labels: HunkLabelEntry[];
    scores: OutcomeScores;
  }): Promise<{ ok: true } | HostFailure>;
}

export type ScoringResult =
  | { ok: true; scores: OutcomeScores; labels: HunkLabelEntry[]; model: string | null }
  | { ok: false; code: string; error: string; model?: string };

/** What `packages/pi-kit-meat-proxy/lib/pipeline.mjs` offers pi-kit's backend (the extension uses the same file). */
export interface ScoringModule {
  scoreThread(host: ScoringHost): Promise<ScoringResult>;
  computeScores(entries: HunkLabelEntry[]): OutcomeScores | null;
  effectiveLabels(stored: Pick<HunkLabelsStore, 'labels' | 'corrections'>): HunkLabelEntry[];
}

/** How long a look at pi's settings is believed: the badge asks on every state it builds. */
const FRESH_MS = 3000;

/**
 * The `@pi-kit/meat-proxy` package as pi-kit sees it: installed into pi's settings once, like `@pi-kit/learn` (`PI_KIT_MEAT_PROXY_PACKAGE=off` skips it), and its
 * scoring module for the scores pi-kit computes itself (after an outcome, and when the person relabels a hunk). **Whether the package is installed decides whether anything of it is drawn:**
 * a removed package leaves the badge with the outcome alone, the Outcome view with plain hunks and Settings without a histogram, though the labels it stored stay in the database.
 */
@Injectable()
export class MeatProxyPackage extends PiKitPackage<ScoringModule> {
  private installed = false;
  private checkedAt = 0;
  private checking: Promise<boolean> | undefined;
  private readonly changeListeners = new Set<(installed: boolean) => void>();

  constructor(meta: MetaRepository) {
    super(meta, {
      name: MEAT_PROXY_PACKAGE,
      folder: 'pi-kit-meat-proxy',
      entry: 'lib/pipeline.mjs',
      setting: 'meat-proxy',
      env: 'PI_KIT_MEAT_PROXY_PACKAGE',
      label: 'meat-proxy',
    });
  }

  scoring(): Promise<ScoringModule | undefined> {
    return this.load();
  }

  /** Is the package installed in pi right now? Answered from the last look (at most a few seconds old); the next look is started in the background. */
  installedNow(): boolean {
    if (Date.now() - this.checkedAt > FRESH_MS) void this.refresh();
    return this.installed;
  }

  /** Looks at pi's settings; tells the listeners when the answer changed (a `pi remove`, a `pi install`). */
  refresh(): Promise<boolean> {
    this.checking ??= this.installedDir()
      .then((dir) => dir !== undefined)
      .catch(() => false)
      .then((now) => {
        this.checkedAt = Date.now();
        const changed = now !== this.installed;
        this.installed = now;
        if (changed) for (const listener of [...this.changeListeners]) listener(now);
        return now;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  /** Told when the package appears in or disappears from pi's settings. */
  onInstalledChange(listener: (installed: boolean) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
}
