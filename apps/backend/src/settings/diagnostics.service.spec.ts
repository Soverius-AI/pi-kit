import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logFiles } from './diagnostics.service';

describe('the log file list of Settings › Advanced', () => {
  it('lists the files of the log folder, newest first, with their size, and ignores folders', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-logs-')));
    writeFileSync(join(dir, 'backend.log'), 'x'.repeat(10));
    writeFileSync(join(dir, 'update.log'), 'y'.repeat(3));
    mkdirSync(join(dir, 'archive'));
    utimesSync(join(dir, 'backend.log'), new Date(2026, 9, 1), new Date(2026, 9, 1));
    utimesSync(join(dir, 'update.log'), new Date(2026, 9, 2), new Date(2026, 9, 2));
    const logs = logFiles(dir);
    expect(logs.map((l) => [l.name, l.size])).toEqual([
      ['update.log', 3],
      ['backend.log', 10],
    ]);
    expect(logs[0]?.path).toBe(join(dir, 'update.log'));
  });

  it('says nothing for a folder that does not exist yet', () => {
    expect(logFiles(join(tmpdir(), 'pk-no-such-logs-folder'))).toEqual([]);
  });
});
