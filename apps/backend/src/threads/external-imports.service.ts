import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { type ExternalSessions, type ImportExternalSession, type ThreadDetail, redact } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { PiSessionService } from '../pi/pi-session.service';
import {
  type TranscriptCache,
  canonicalCwd,
  discoverExternalSessions,
  fingerprint,
  loadCodexSnapshot,
} from './external-sessions';
import { ThreadsService } from './threads.service';

/** Per source session: the thread each imported version became, by listing fingerprint or `content:` hash. */
type Ledger = Record<string, Record<string, string>>;
/** One setting for every project: a source session's key does not depend on the folder. */
const LEDGER = 'imports';

/** A project's Claude Code and Codex sessions, imported as independent pi threads. The sources are only read. */
@Injectable()
export class ExternalImportsService {
  private readonly importing = new Map<string, Promise<ThreadDetail>>();
  private readonly transcripts: TranscriptCache = new Map();

  constructor(
    private readonly threads: ThreadsService,
    private readonly meta: MetaRepository,
    private readonly sessions: PiSessionService,
  ) {
    threads.onDeleted(async (id) => await this.drop(id));
  }

  async discover(cwd: string): Promise<ExternalSessions> {
    this.threads.requireDirectory(cwd);
    const discovery = await discoverExternalSessions(cwd, { cache: this.transcripts });
    const ledger = await this.ledger();
    return {
      unavailable: discovery.unavailable,
      skipped: discovery.skipped,
      sessions: await Promise.all(
        discovery.sessions.map(async (session) => {
          const versions = ledger[session.key] ?? {};
          const threadId = versions[session.fingerprint];
          const importedThreadId = threadId && (await this.threads.find(threadId)) ? threadId : null;
          return {
            key: session.key,
            source: session.source,
            title: redact(session.title),
            updatedAt: session.updatedAt,
            fingerprint: session.fingerprint,
            importedThreadId,
            // Without a surviving imported copy there is nothing the source changed from.
            status: importedThreadId
              ? 'imported'
              : (await Promise.all(Object.values(versions).map(async (id) => await this.threads.find(id)))).some(
                    Boolean,
                  )
                ? 'changed'
                : 'new',
          };
        }),
      ),
    };
  }

  /** Retrying an import reuses the matching snapshot. Changed sources always become separate native pi sessions. */
  async importSession(cwd: string, request: ImportExternalSession): Promise<ThreadDetail> {
    this.threads.requireDirectory(cwd);
    const lock = `${await canonicalCwd(cwd)}:${request.key}:${request.fingerprint}`;
    const running = this.importing.get(lock);
    if (running) return running;
    const work = this.importOnce(cwd, request).finally(() => this.importing.delete(lock));
    this.importing.set(lock, work);
    return work;
  }

  private async importOnce(cwd: string, request: ImportExternalSession): Promise<ThreadDetail> {
    const versions = (await this.ledger())[request.key] ?? {};
    const imported = await this.threadOf(versions[request.fingerprint]);
    if (imported) return imported;
    const discovery = await discoverExternalSessions(cwd, { key: request.key, cache: this.transcripts });
    let snapshot = discovery.sessions.find((session) => session.key === request.key);
    if (!snapshot || snapshot.fingerprint !== request.fingerprint)
      throw new ConflictException('The source session changed or is unavailable. Check again before importing.');
    if (snapshot.source === 'codex')
      snapshot = await loadCodexSnapshot(snapshot).catch((error: unknown) => {
        throw new ConflictException(error instanceof Error ? error.message : 'The Codex session is unavailable.');
      });
    if (!snapshot.messages.length) throw new BadRequestException('The source has no importable conversation history.');
    // A source whose metadata moved while its history stayed the same is the import we already have.
    const contentKey = `content:${fingerprint({ title: snapshot.title, messages: snapshot.messages })}`;
    const same = await this.threadOf(versions[contentKey]);
    if (same) {
      await this.remember(request.key, same.id, [request.fingerprint]);
      return same;
    }
    const session = await this.sessions.importHistory(cwd, snapshot.title, snapshot.messages, {
      source: snapshot.source,
      sourceId: snapshot.nativeId,
      fingerprint: snapshot.fingerprint,
      importedAt: Date.now(),
    });
    const detail = await this.threads.adopt(session);
    await this.remember(request.key, detail.id, [request.fingerprint, contentKey]);
    return detail;
  }

  private async threadOf(id: string | undefined): Promise<ThreadDetail | undefined> {
    return id ? await this.threads.find(id) : undefined;
  }

  private async ledger(): Promise<Ledger> {
    const value = await this.meta.getSetting(LEDGER);
    return value && typeof value === 'object' ? (value as Ledger) : {};
  }

  /** Reads the ledger again before writing: another import may have finished meanwhile. */
  private async remember(source: string, threadId: string, versions: string[]): Promise<void> {
    const ledger = await this.ledger();
    ledger[source] = { ...ledger[source], ...Object.fromEntries(versions.map((version) => [version, threadId])) };
    await this.meta.setSetting(LEDGER, ledger);
  }

  /** A deleted thread takes its entries along: the ledger only names threads that exist, and an empty one is not kept. */
  private async drop(threadId: string): Promise<void> {
    const ledger = await this.ledger();
    let dropped = false;
    for (const [source, versions] of Object.entries(ledger)) {
      for (const [version, id] of Object.entries(versions)) {
        if (id !== threadId) continue;
        delete versions[version];
        dropped = true;
      }
      if (!Object.keys(versions).length) delete ledger[source];
    }
    if (!dropped) return;
    if (Object.keys(ledger).length) await this.meta.setSetting(LEDGER, ledger);
    else await this.meta.deleteSetting(LEDGER);
  }
}
