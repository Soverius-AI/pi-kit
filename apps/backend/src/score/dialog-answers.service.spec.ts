import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { SignalsRepository } from '../db/signals.repository';
import { DialogAnswersService } from './dialog-answers.service';

let dir: string;
let db: DatabaseService;
let signals: SignalsRepository;
let service: DialogAnswersService;
let answerListener: (threadId: string, answered: { request: unknown; answer: unknown }) => void;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-answers-')));
  db = await DatabaseService.create({ dataDir: dir });
  signals = new SignalsRepository(db);
  service = new DialogAnswersService(
    {
      onDialogAnswered: (l: typeof answerListener) => {
        answerListener = l;
        return () => undefined;
      },
    } as never,
    signals,
  );
  service.onModuleInit();
});
afterEach(async () => {
  service.onModuleDestroy();
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('dialogs the person answered', () => {
  it('are kept for the ledger', async () => {
    answerListener('t1', {
      request: { method: 'confirm', title: 'Allow bash?' },
      answer: { status: 'resolved', confirmed: true },
    });
    expect(await signals.answers('t1')).toMatchObject([
      { method: 'confirm', title: 'Allow bash?', status: 'resolved', confirmed: true },
    ]);
  });
});
