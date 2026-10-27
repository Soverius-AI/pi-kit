import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Smoke mode: `PI_KIT_SMOKE=1` is how `scripts/release-smoke.mjs` runs a packaged build. It changes three things and nothing else:
 *  - the app keeps its data and logs under `PI_KIT_DATA_DIR`, not in the user's own application-data and log folders,
 *  - once the backend is healthy and the renderer has drawn, `smoke.json` appears in that folder with the backend's address and token (the
 * script cannot see the random port and token the main process picked),
 *  - SIGTERM quits the app like Cmd+Q does, so a script can end it cleanly on macOS and Linux (Windows: `taskkill` without /F closes the window).
 * Unset, none of this runs.
 */
export const SMOKE = process.env['PI_KIT_SMOKE'] === '1';

/** The scratch folder smoke mode uses, or undefined outside smoke mode (or without PI_KIT_DATA_DIR, in which case the normal folders are used). */
export function smokeDataDir(): string | undefined {
  return SMOKE ? process.env['PI_KIT_DATA_DIR'] || undefined : undefined;
}

export interface SmokeReport {
  url: string;
  token: string;
  pid: number;
  backendPid: number | undefined;
  version: string;
  electron: string;
  platform: string;
  arch: string;
  packaged: boolean;
  /** The renderer's URL and how many children `<pk-root>` has: proof that the Angular build was served and started. */
  window: { url: string; rootChildren: number; backendStatus: number; backendError?: string };
  splash: { loaded: boolean; shown: boolean };
}

/** Written atomically (temp file, then rename) so a reader never sees half of it. */
export function writeSmokeReport(dir: string, report: SmokeReport): void {
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, 'smoke.json.tmp');
  writeFileSync(temp, JSON.stringify(report, null, 2));
  renameSync(temp, join(dir, 'smoke.json'));
}
