import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * An append-only log file (`~/Library/Logs/pi-kit/main.log` and `backend.log` on macOS) that is rotated once at 5 MB. A packaged app
 * has no terminal, so this is where "did the backend start, and on which port" is answered.
 */
export class FileLog {
  private readonly path: string;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, name);
    try {
      if (statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`);
    } catch {
      // No log yet.
    }
  }

  line(text: string): void {
    this.write(`${new Date().toISOString()} ${text}\n`);
  }

  write(text: string): void {
    try {
      appendFileSync(this.path, text);
    } catch {
      // A log that cannot be written must not take the app down.
    }
  }
}
