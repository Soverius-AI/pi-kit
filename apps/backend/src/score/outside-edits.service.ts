import { existsSync } from 'node:fs';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventLogRepository } from '../db/event-log.repository';
import { SignalsRepository } from '../db/signals.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { touchesHead } from '../threads/outcome-rules';
import { WatchService } from '../watch/watch.service';
import { answerFromDialog, handEditedPaths } from './score-rules';

/** A folder stays watched for hand edits this long after the last run of one of its threads. */
const WATCH_TTL_MS = 2 * 60 * 60_000;
const SWEEP_MS = 10 * 60_000;

/**
 * The records the Meat Proxy Score needs that nothing else kept: the files the folder watcher saw change in a thread's folder while no run of pi
 * was writing there, which are the person's edits by hand, and the dialogs the person answered. It holds the folder of every thread that runs, for two hours after the
 * last run, and writes a file to the record of the threads of that folder that ran lately; a batch that moves `HEAD` (a checkout, a pull, a merge) or that arrives while a run is
 * going on, or in the moment after one ended, is not a hand. What it cannot see: an edit made while pi was running in the same folder, and a change made while pi-kit was not running.
 */
@Injectable()
export class OutsideEditsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutsideEditsService.name);
  private readonly held = new Map<string, { off: () => void; at: number }>();
  /** When the newest run in each folder ended. */
  private readonly lastEnd = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly threads: ThreadsRepository,
    private readonly events: EventLogRepository,
    private readonly sessions: PiSessionService,
    private readonly watch: WatchService,
    private readonly signals: SignalsRepository,
  ) {}

  onModuleInit(): void {
    this.offs.push(
      this.events.onRunChange((threadId, change) => {
        const row = this.threads.get(threadId);
        if (!row) return;
        const folder = this.folderOf(row);
        this.hold(folder);
        if (change === 'end') this.lastEnd.set(folder, Date.now());
      }),
      this.watch.onBatch((cwd, batch) => this.onBatch(cwd, batch.paths)),
      this.sessions.onDialogAnswered((threadId, { request, answer }) => {
        const noted = answerFromDialog(request, answer);
        if (noted) this.signals.noteAnswer(threadId, Date.now(), noted);
      }),
    );
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs) off();
    for (const { off } of this.held.values()) off();
    this.held.clear();
  }

  /** The folder pi works in for the row: its worktree while that exists, else the project's folder. */
  private folderOf(row: ThreadRow): string {
    return row.worktreePath && existsSync(row.worktreePath) ? row.worktreePath : row.cwd;
  }

  private hold(folder: string): void {
    const held = this.held.get(folder);
    if (held) {
      held.at = Date.now();
      return;
    }
    this.held.set(folder, { off: this.watch.subscribe(folder, () => undefined), at: Date.now() });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [folder, held] of this.held) {
      if (now - held.at < WATCH_TTL_MS) continue;
      held.off();
      this.held.delete(folder);
    }
  }

  /** A watcher batch of `folder`: which of its paths are a hand, and which threads they belong to. */
  onBatch(folder: string, paths: readonly string[], now = Date.now()): void {
    if (!this.held.has(folder)) return;
    const rows = this.threads.all().filter((row) => this.folderOf(row) === folder);
    if (rows.length === 0) return;
    const running = rows.some((row) => this.events.lastRun(row.id)?.status === 'running');
    const ended = this.lastEnd.get(folder);
    const hand = handEditedPaths({ paths, running, sinceRunEnd: ended === undefined ? null : now - ended, headMoved: touchesHead(paths) });
    if (hand.length === 0) return;
    // The threads that ran in the folder lately own the edit: a thread nobody has run does not.
    const owners = rows.filter((row) => {
      const run = this.events.lastRun(row.id);
      return run !== undefined && (this.sessions.has(row.id) || (run.endedAt ?? run.startedAt) > now - WATCH_TTL_MS);
    });
    for (const row of owners) for (const path of hand) this.signals.noteOutsideEdit(row.id, path, now);
    if (owners.length > 0) this.logger.debug(`${hand.length} hand edit(s) in ${folder} noted for ${owners.length} thread(s)`);
  }
}
