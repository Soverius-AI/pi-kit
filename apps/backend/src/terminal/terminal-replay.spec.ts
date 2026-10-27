import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalEvent } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { RedactionService } from '../db/redaction.service';
import { TerminalReplayRepository } from '../db/terminal-replay.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { TerminalService } from './terminal.service';

const KEY = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe.skipIf(process.platform === 'win32')('the terminal’s last screen in the database', () => {
  it('is saved with key shapes masked, shown to a late client masked, and replayed first after the backend restarted', async () => {
    const database = new DatabaseService({ dataDir: realpathSync(mkdtempSync(join(tmpdir(), 'pk-termdb-'))) });
    const replay = new TerminalReplayRepository(database);
    const redaction = new RedactionService(new MetaRepository(database), new ThreadsRepository(database));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pk-termcwd-')));

    const first = new TerminalService(replay, redaction);
    first.start(cwd, 80, 24);
    let seen = '';
    first.subscribe(cwd, (e) => {
      if (e.type === 'data') seen += e.data;
    });
    first.write(cwd, `echo "token ${KEY}"\r`);
    // The shell's own output (the command is echoed back, then printed) is what is kept; wait until it has arrived twice.
    for (let i = 0; i < 200 && seen.split(KEY).length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    expect(seen.split(KEY).length).toBeGreaterThanOrEqual(3);
    first.onModuleDestroy(); // saves the screen on the way out
    const saved = replay.get(cwd)?.data ?? '';
    expect(saved).toContain('[redacted github token …6789]');
    expect(saved).not.toContain(KEY);

    const second = new TerminalService(replay, redaction);
    second.start(cwd, 80, 24);
    const events: TerminalEvent[] = [];
    second.subscribe(cwd, (e) => events.push(e));
    const shown = events.map((e) => (e.type === 'data' ? e.data : '')).join('');
    expect(shown).toContain('[redacted github token …6789]');
    expect(shown).toContain('end of the previous terminal session');
    expect(shown).not.toContain(KEY);
    second.onModuleDestroy();
    database.onApplicationShutdown();
  }, 30_000);
});
