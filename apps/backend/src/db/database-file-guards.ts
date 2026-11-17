import { closeSync, existsSync, openSync, readSync } from 'node:fs';

const PLAIN_HEADER = 'SQLite format 3\0';

/** Inspect only the header; never open unknown files through SQLite. */
export function isPlainDatabase(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, 16, 0);
    return read === 16 && head.toString('latin1') === PLAIN_HEADER;
  } finally {
    closeSync(fd);
  }
}

/** Refuse interrupted legacy transitions without modifying retained originals. */
export function assertNoPendingDatabaseTransition(path: string): void {
  if (['.plaintext', '.encrypted', '.encrypting', '.decrypting'].some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new Error(
      'An interrupted database protection transition needs recovery. Original database files were retained; do not delete them or start a replacement database.',
    );
  }
}
