import type {
  ProtectionBinding,
  SandboxOwnerState,
  ThreadProtectionRepository,
} from '../db/thread-protection.repository';
import { ThreadProtectionService } from './thread-protection.service';

/** A `ThreadProtectionService` over in-memory rows, for specs that do not open a database. */
export class ThreadProtectionTesting {
  readonly bindings = new Map<string, ProtectionBinding>();
  readonly owners = new Map<string, SandboxOwnerState>();
  readonly repository = {
    binding: (threadId: string) => this.bindings.get(threadId),
    setBinding: (threadId: string, binding: ProtectionBinding) => void this.bindings.set(threadId, { ...binding }),
    deleteBinding: (threadId: string) => void this.bindings.delete(threadId),
    ownerState: (ownerId: string) => this.owners.get(ownerId),
    setOwnerState: (ownerId: string, state: SandboxOwnerState) => void this.owners.set(ownerId, state),
    clearOwner: (ownerId: string) => void this.owners.delete(ownerId),
  } as unknown as ThreadProtectionRepository;

  service(dataDir = '/private/pi-kit-state'): ThreadProtectionService {
    return new ThreadProtectionService(this.repository, { dataDir });
  }

  static bypass(): ThreadProtectionService {
    return new ThreadProtectionTesting().service();
  }
}
