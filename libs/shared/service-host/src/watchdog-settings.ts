import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Per-profile opt-in, shared by the host and the CLI even when no host is running. */
export function readWatchdogEnabled(dataDir: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, 'watchdog.json'), 'utf8'));
    return !!value && typeof value === 'object' && (value as { enabled?: unknown }).enabled === true;
  } catch {
    // A missing or unreadable preference must never turn automatic recovery on.
    return false;
  }
}

export function writeWatchdogEnabled(dataDir: string, enabled: boolean): void {
  mkdirSync(dataDir, { recursive: true });
  const temporary = join(dataDir, `watchdog.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(dataDir, 'watchdog.json'));
  } finally {
    rmSync(temporary, { force: true });
  }
}
