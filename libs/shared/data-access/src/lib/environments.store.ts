import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  EntryApiClient,
  WORKBENCH,
  isDeviceConnection,
  WorkbenchSelectionSchema,
  peersList,
  peersProjects,
  unwrap,
  workbenchFragment,
  workspacesWorkspaces,
  type WorkbenchSelection,
} from '@pi-kit/api';
import type { PeerManager, ProjectRef, Workspace } from '@pi-kit/protocol';
import { writeStorage } from './store';

export type EnvironmentStatus = 'online' | 'checking' | 'offline';
export interface EnvironmentProjects {
  instanceId: string;
  name: string;
  local: boolean;
  projects: Workspace[];
  loading: boolean;
  error?: string;
}
/** Entry-owned directory. Remote discovery/reads never hold up the local project list or change execution context. */
@Injectable({ providedIn: 'root' })
export class EnvironmentsStore {
  /** The selection a reload resumes from: stored for the next start and mirrored into the URL fragment. */
  static remember(target: WorkbenchSelection): void {
    writeStorage('pi-kit.workbench-ref.v1', JSON.stringify(target), 'controller');
    const url = new URL(window.location.href);
    url.hash = workbenchFragment(target);
    window.history.replaceState(null, '', url.href);
  }

  readonly api = inject(EntryApiClient);
  readonly context = inject(WORKBENCH);
  readonly manager = signal<PeerManager | undefined>(undefined);
  readonly groups = signal<EnvironmentProjects[]>([]);
  readonly picker = signal<{ initialOwner?: string; pick: (project: ProjectRef) => Promise<void> } | undefined>(
    undefined,
  );
  requestPicker(
    pick: (project: ProjectRef) => Promise<void>,
    initialOwner = this.manager()?.self.instanceId ?? this.context.entryId,
  ): void {
    this.picker.set({ initialOwner, pick });
    void this.refresh();
  }
  readonly hasPeers = computed(() => !!this.manager()?.peers.some((peer) => peer.state === 'active'));
  ownerId(): string | undefined {
    return this.context.ownerId ?? this.manager()?.self.instanceId;
  }
  readonly ownerName = computed(() => {
    const manager = this.manager(),
      id = this.ownerId();
    return manager && manager.self.instanceId === id
      ? manager.self.name
      : manager?.peers.find((peer) => peer.peerId === id && peer.state === 'active')?.name;
  });
  readonly entryName = computed(() => this.manager()?.self.name ?? '');
  kind(remote = this.context.remote): string {
    return remote
      ? 'environments.switch.remote'
      : isDeviceConnection()
        ? 'environments.switch.paired'
        : 'environments.switch.thisComputer';
  }
  readonly ownerKind = computed(() => this.kind());
  /** Reachability, not locality: a failed load stays offline until a retry answers, so the dot does not flicker while it retries. */
  status(instanceId = this.ownerId()): EnvironmentStatus {
    const group = this.groups().find((value) => value.instanceId === instanceId);
    return group?.error ? 'offline' : !group || group.loading ? 'checking' : 'online';
  }
  readonly ownerMissing = computed(() => this.context.remote && !!this.manager() && this.ownerName() === undefined);
  backToEntry(): Promise<void> {
    const instanceId = this.manager()?.self.instanceId ?? this.context.entryId;
    return instanceId ? this.navigate({ instanceId }) : Promise.resolve();
  }
  private refreshing?: Promise<void>;
  private readonly loads = new Map<string, Promise<void>>();
  private stopped = false;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopped = true;
      clearTimeout(this.recheck);
      clearTimeout(this.retry);
    });
  }
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const manager = await unwrap(peersList({ client: this.api.client }));
        if (this.stopped) return;
        this.manager.set(manager);
        const previous = this.groups();
        const descriptors = [
          { instanceId: manager.self.instanceId, name: manager.self.name, local: true },
          ...manager.peers
            .filter((peer) => peer.state === 'active')
            .map((peer) => ({ instanceId: peer.peerId, name: peer.name, local: false })),
        ];
        this.groups.set(
          descriptors.map((descriptor) => ({
            projects: [],
            ...previous.find((group) => group.instanceId === descriptor.instanceId),
            ...descriptor,
            loading: false,
          })),
        );
        for (const group of this.groups()) void this.load(group.instanceId);
        // A pairing finishes when the other instance confirms, which nothing announces here: look again until none is in flight.
        clearTimeout(this.recheck);
        if (manager.requests.length || manager.peers.some((peer) => peer.state === 'pending' || peer.unpairPending))
          this.recheck = setTimeout(() => void this.refresh(), 3000);
      } catch {
        /* A legacy/offline entry keeps the existing local workflow usable. */
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  load(instanceId: string): Promise<void> {
    const existing = this.loads.get(instanceId);
    if (existing) return existing;
    const group = this.groups().find((value) => value.instanceId === instanceId);
    if (!group) return Promise.resolve();
    const patch = (change: Partial<EnvironmentProjects>) => {
      if (!this.stopped)
        this.groups.update((values) =>
          values.map((value) => (value.instanceId === instanceId ? { ...value, ...change } : value)),
        );
    };
    patch({ loading: true });
    const pending = (async () => {
      try {
        const projects = group.local
          ? await unwrap(workspacesWorkspaces({ client: this.api.client }))
          : await unwrap(peersProjects({ client: this.api.client, path: { peerId: instanceId } }));
        if (projects.some((project) => project.instanceId && project.instanceId !== instanceId))
          throw new Error('Project owner mismatch.');
        patch({ projects, loading: false, error: undefined });
      } catch {
        patch({ loading: false, error: 'unavailable' });
        // An instance that restarts, sleeps or waits for its keychain answers again later: look again until it does.
        this.retry ??= setTimeout(() => {
          this.retry = undefined;
          for (const value of this.groups()) if (value.error) void this.load(value.instanceId);
        }, 10000);
      }
    })().finally(() => this.loads.delete(instanceId));
    this.loads.set(instanceId, pending);
    return pending;
  }
  /** Full workbench recreation captures route/auth/owner together and detaches, rather than aborting, existing work. */
  async navigate(value: WorkbenchSelection): Promise<void> {
    const target = WorkbenchSelectionSchema.parse(value);
    const leaving = new CustomEvent('pk-workbench-leave', { cancelable: true, detail: { target } });
    if (!window.dispatchEvent(leaving)) return;
    EnvironmentsStore.remember(target);
    window.location.reload();
  }
}
