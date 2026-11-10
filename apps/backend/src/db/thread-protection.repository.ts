import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from './database.service';

export const ProtectionBindingSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['bypass', 'sandboxed']),
    generation: z.number().int().nonnegative(),
    experimentalWindowsAccepted: z.boolean(),
  })
  .strict();
export type ProtectionBinding = z.infer<typeof ProtectionBindingSchema>;
export type SandboxOwnerState = 'starting' | 'active' | 'recovery-required';

/** `thread_protection` (a thread's mode) and `sandbox_owners` (sandboxes that have not confirmed their shutdown). */
@Injectable()
export class ThreadProtectionRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** `undefined`: the thread was never given a mode (Bypass). */
  binding(threadId: string): ProtectionBinding | undefined {
    const row = this.db
      .prepare('SELECT mode, generation, windows_accepted FROM thread_protection WHERE thread_id = ?')
      .get(threadId) as { mode: ProtectionBinding['mode']; generation: number; windows_accepted: number } | undefined;
    return row
      ? {
          version: 1,
          mode: row.mode,
          generation: row.generation,
          experimentalWindowsAccepted: row.windows_accepted === 1,
        }
      : undefined;
  }

  setBinding(threadId: string, binding: ProtectionBinding): void {
    this.db
      .prepare(
        `INSERT INTO thread_protection (thread_id, mode, generation, windows_accepted) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET mode = excluded.mode, generation = excluded.generation, windows_accepted = excluded.windows_accepted`,
      )
      .run(threadId, binding.mode, binding.generation, binding.experimentalWindowsAccepted ? 1 : 0);
  }

  deleteBinding(threadId: string): void {
    this.db.prepare('DELETE FROM thread_protection WHERE thread_id = ?').run(threadId);
  }

  ownerState(ownerId: string): SandboxOwnerState | undefined {
    const row = this.db.prepare('SELECT state FROM sandbox_owners WHERE owner_id = ?').get(ownerId) as
      { state: SandboxOwnerState } | undefined;
    return row?.state;
  }

  setOwnerState(ownerId: string, state: SandboxOwnerState): void {
    this.db
      .prepare(
        'INSERT INTO sandbox_owners (owner_id, state) VALUES (?, ?) ON CONFLICT (owner_id) DO UPDATE SET state = excluded.state',
      )
      .run(ownerId, state);
  }

  /** The owner confirmed its shutdown, or the person confirmed its recovery. */
  clearOwner(ownerId: string): void {
    this.db.prepare('DELETE FROM sandbox_owners WHERE owner_id = ?').run(ownerId);
  }
}
