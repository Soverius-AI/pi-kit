import { statSync } from 'node:fs';

/** Modification time of a session file in epoch milliseconds, or null if it does not exist. */
export function sessionMtime(path: string): number | null {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}
