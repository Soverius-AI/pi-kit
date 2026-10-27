import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { About, PiUpdateCheck } from '@pi-kit/protocol';
import { loadPi, piResolution } from './load-pi';
import { isNewerVersion } from './version';

/** The endpoint pi's own startup check asks (`checkForNewPiVersion` in pi's `utils/version-check.js`, which the package does not export). */
const LATEST_VERSION_URL = 'https://pi.dev/api/latest-version';
const TIMEOUT_MS = 10_000;
/** An answer is reused for this long, so reopening Settings does not call pi.dev every time. */
const CACHE_MS = 10 * 60_000;
const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * The installed pi and whether a newer one has been published. pi-kit runs sessions with the pi SDK it
 * resolves, so "installed" is the loaded copy's `VERSION`. The check is pi's own: the same endpoint, `PI_OFFLINE` and
 * `PI_SKIP_VERSION_CHECK` honoured, the same "anything not comparable that differs is newer" rule. It only reads; the
 * update itself is `UpdateService`, which also calls this check on launch and every 6 hours.
 */
@Injectable()
export class PiUpdateService {
  private cached: { at: number; result: PiUpdateCheck } | undefined;

  async about(): Promise<About> {
    const pi = await loadPi();
    const resolution = piResolution();
    return {
      app: { name: 'pi-kit', version: appVersion(), desktop: process.env['PI_KIT_DESKTOP'] === '1' },
      pi: { version: pi.VERSION, packageName: PI_PACKAGE, packageDir: pi.getPackageDir(), source: resolution.source, range: resolution.range, notes: resolution.notes },
      node: process.versions.node,
    };
  }

  async check(force = false): Promise<PiUpdateCheck> {
    const pi = await loadPi();
    const current = pi.VERSION;
    const base = { current, updateAvailable: false, checkedAt: Date.now(), command: 'pi update' };
    if (process.env['PI_OFFLINE']) return { ...base, skipped: 'offline' };
    if (process.env['PI_SKIP_VERSION_CHECK']) return { ...base, skipped: 'disabled' };
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS && this.cached.result.current === current) return this.cached.result;
    let result: PiUpdateCheck;
    try {
      const res = await fetch(LATEST_VERSION_URL, {
        headers: { 'User-Agent': `pi-kit/${appVersion()} (pi ${current})`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`pi.dev answered ${res.status}`);
      const data = (await res.json()) as { version?: unknown; note?: unknown };
      const latest = typeof data.version === 'string' ? data.version.trim() : '';
      if (!latest) throw new Error('pi.dev did not name a version');
      const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : undefined;
      result = { ...base, latest, updateAvailable: isNewerVersion(latest, current), ...(note ? { note } : {}) };
    } catch (error) {
      result = { ...base, error: error instanceof Error ? error.message : String(error) };
      return result; // a failure is not cached
    }
    this.cached = { at: Date.now(), result };
    return result;
  }
}

/** The desktop app passes its version (`PI_KIT_VERSION`); `dev:web` does too; otherwise the nearest package.json named pi-kit. */
export function appVersion(): string {
  const fromEnv = process.env['PI_KIT_VERSION'];
  if (fromEnv) return fromEnv;
  for (let dir = process.cwd(), i = 0; i < 6; i++, dir = dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (manifest.name === 'pi-kit' && manifest.version) return manifest.version;
    } catch {
      // keep looking upwards
    }
  }
  return '0.0.0';
}
