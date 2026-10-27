import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ThreadDetail } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { ThreadsService } from '../threads/threads.service';

/** Persistent sidebar entries for learning; the source keeps its transcript and draft provenance. */
@Injectable()
export class LearningThreadsService {
  private readonly opening = new Map<string, Promise<ThreadDetail>>();

  constructor(private readonly meta: MetaRepository, private readonly rows: ThreadsRepository, private readonly threads: ThreadsService) {}

  open(sourceId: string): Promise<ThreadDetail> {
    const source = this.rows.get(sourceId);
    if (!source) throw new NotFoundException('There is no such source thread.');
    if (this.meta.learningSource(sourceId) || this.meta.isVerificationThread(sourceId)) throw new ConflictException('Choose the original chat to learn from.');
    const pending = this.opening.get(sourceId);
    if (pending) return pending;
    const work = this.ensure(sourceId);
    this.opening.set(sourceId, work);
    void work.finally(() => { if (this.opening.get(sourceId) === work) this.opening.delete(sourceId); }).catch(() => undefined);
    return work;
  }

  private async ensure(sourceId: string): Promise<ThreadDetail> {
    const existing = Object.entries(this.meta.learningThreads()).find(([id, source]) => source === sourceId && this.rows.get(id));
    if (existing) return this.threads.patch(existing[0], { archived: false });
    const source = this.rows.get(sourceId);
    if (!source) throw new NotFoundException('There is no such source thread.');
    const title = `Learn: ${source.title || source.preview || 'Untitled chat'}`.slice(0, 200);
    return this.threads.create(source.cwd, title, undefined, undefined, { setup: 'skip', onId: id => this.meta.markLearningThread(id, sourceId) });
  }
}
