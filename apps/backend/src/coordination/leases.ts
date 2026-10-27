/** How long a thread keeps a file lease after its last edit of the file. */
export const LEASE_TTL_MS = 30 * 60_000;

/** A soft claim: `threadId` edited or wrote `path` (relative to `cwd`, the folder the thread runs in), first at `since` and last at `at`. */
export interface Lease {
  threadId: string;
  cwd: string;
  path: string;
  since: number;
  at: number;
}

/** A lease counts while its last activity is younger than the TTL. */
export function isLeaseActive(lease: Pick<Lease, 'at'>, now: number, ttl = LEASE_TTL_MS): boolean {
  return now - lease.at < ttl;
}

/**
 * The lease after `threadId` touched `path` again at `now`: an active lease keeps its `since` and moves `at`, an expired or missing one starts over
 * (a lease that lapsed and is taken again is a new claim).
 */
export function renewLease(previous: Lease | undefined, key: Pick<Lease, 'threadId' | 'cwd' | 'path'>, now: number, ttl = LEASE_TTL_MS): Lease {
  const since = previous && isLeaseActive(previous, now, ttl) ? previous.since : now;
  return { ...key, since, at: now };
}
