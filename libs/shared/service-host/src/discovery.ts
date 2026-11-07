import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Who runs the host: the desktop app as its child (`app`), the operating system (`login`), or `pi-kit serve` in a terminal. */
export type HostLevel = 'app' | 'login' | 'serve';

/** `<dataDir>/service.json`: how a desktop finds and enters the host that owns the folder. */
export interface HostDiscovery {
  pid: number;
  version: string;
  level: HostLevel;
  socket: string;
  token: string;
  startedAt: string;
}

const FILE = 'service.json';

/** Whether release `version` is newer than `than`; a development or unknown version is never newer, so it never wins. */
export function isNewerVersion(version: string, than: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(than);
  if (!a || !b) return false;
  const differs = a.findIndex((part, i) => part !== b[i]);
  return differs !== -1 && a[differs] > b[differs];
}

export function writeDiscovery(dataDir: string, discovery: HostDiscovery): void {
  const path = join(dataDir, FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(discovery, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

export function readDiscovery(dataDir: string): HostDiscovery | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')) as Partial<HostDiscovery>;
    if (
      !Number.isInteger(value.pid) ||
      typeof value.version !== 'string' ||
      (value.level !== 'app' && value.level !== 'login' && value.level !== 'serve') ||
      typeof value.socket !== 'string' ||
      typeof value.token !== 'string' ||
      typeof value.startedAt !== 'string'
    )
      return undefined;
    return value as HostDiscovery;
  } catch {
    return undefined;
  }
}

/** Removes the file only while it still names `pid`, so a host never deletes its successor's. */
export function removeDiscovery(dataDir: string, pid: number): void {
  if (readDiscovery(dataDir)?.pid === pid) rmSync(join(dataDir, FILE), { force: true });
}

/** The host that owns the folder, if it is still running. */
export function liveDiscovery(dataDir: string): HostDiscovery | undefined {
  const found = readDiscovery(dataDir);
  return found && isAlive(found.pid) ? found : undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
