import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SignalsRepository } from '../db/signals.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { answerFromDialog } from './score-rules';

/** Keeps the dialogs the person answered, which pi does not: the ledger of the Meat Proxy Score reads them (`pi-kit:thread:transcript`). */
@Injectable()
export class DialogAnswersService implements OnModuleInit, OnModuleDestroy {
  private off: (() => void) | undefined;

  constructor(
    private readonly sessions: PiSessionService,
    private readonly signals: SignalsRepository,
  ) {}

  onModuleInit(): void {
    this.off = this.sessions.onDialogAnswered((threadId, { request, answer }) => {
      const noted = answerFromDialog(request, answer);
      if (noted) this.signals.noteAnswer(threadId, Date.now(), noted);
    });
  }

  onModuleDestroy(): void {
    this.off?.();
  }
}
