import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConflictException, ForbiddenException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { SetThreadProtection, ThreadProtection, ThreadProtectionState } from '@pi-kit/protocol';
import type { SandboxClient, SandboxError } from '@pi-kit/sandbox/core';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { type ProtectionBinding, ThreadProtectionRepository } from '../db/thread-protection.repository';

export type { SandboxClient };

interface SandboxEntries {
  core: typeof import('@pi-kit/sandbox/core');
  pi: typeof import('@pi-kit/sandbox/pi');
  durable: typeof import('@pi-kit/sandbox/durable');
}

/** The shipped `pi-sandbox` package, loaded only once a thread or agent is sandboxed. */
export class SandboxPackage {
  private static readonly nativeImport = new Function('specifier', 'return import(specifier)') as <T>(
    specifier: string,
  ) => Promise<T>;

  static dir(): string {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      join(__dirname, 'packages', 'pi-sandbox'),
      ...(resources ? [join(resources, 'backend', 'packages', 'pi-sandbox')] : []),
      ...(basename(__dirname) === 'pi' && basename(dirname(__dirname)) === 'src'
        ? [resolve(__dirname, '../../../../packages/pi-sandbox')]
        : []),
    ];
    const found = candidates.find((dir) => existsSync(join(dir, 'dist', 'core.js')));
    if (!found) throw new Error('The sandbox package is not installed. Sandboxed execution is blocked.');
    return found;
  }

  static load<K extends keyof SandboxEntries>(entry: K): Promise<SandboxEntries[K]> {
    return SandboxPackage.nativeImport(pathToFileURL(join(SandboxPackage.dir(), 'dist', `${entry}.js`)).href);
  }
}

interface Owner {
  key: string;
  ready: Promise<SandboxClient>;
  client?: SandboxClient;
  error?: string;
  /** Windows: the sandbox needs SRT's one-time machine setup first. */
  setupRequired?: boolean;
}

const HELD = 'An earlier sandbox of this thread did not confirm its shutdown; its processes may still run.';

/** A thread's protection mode and the sandboxes of its sessions and agents. Sandboxed work never falls back to the host. */
@Injectable()
export class ThreadProtectionService implements OnModuleDestroy {
  static readonly BYPASS: ProtectionBinding = Object.freeze({
    version: 1,
    mode: 'bypass',
    generation: 0,
    experimentalWindowsAccepted: false,
  });
  private readonly owners = new Map<string, Owner>();
  private readonly failedCleanup = new Map<string, string>();
  private readonly changing = new Set<string>();
  private windowsSetup: Promise<void> | undefined;
  private agentGuard: ((threadId: string) => boolean) | undefined;

  constructor(
    private readonly store: ThreadProtectionRepository,
    @Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir'>,
  ) {}

  /** The background agents tell whether a thread has agents at work; their mode is fixed when they start. */
  setAgentGuard(guard: (threadId: string) => boolean): void {
    this.agentGuard = guard;
  }

  binding(threadId: string): ProtectionBinding {
    return this.store.binding(threadId) ?? { ...ThreadProtectionService.BYPASS };
  }

  status(threadId: string): ThreadProtection {
    const binding = this.binding(threadId);
    const owner = this.owners.get(`thread:${threadId}`);
    const held = this.recoveryReason(threadId);
    const unavailable =
      owner?.error ??
      (owner?.client && owner.client.state !== 'active' ? (owner.client.reason ?? 'The sandbox stopped.') : undefined);
    return {
      mode: binding.mode,
      state: this.stateOf(binding, owner, held, unavailable),
      generation: binding.generation,
      experimentalWindowsAccepted: binding.experimentalWindowsAccepted,
      platform: process.platform,
      reason: held ?? unavailable ?? null,
    };
  }

  assertAdmitted(threadId: string): void {
    if (this.changing.has(threadId))
      throw new ConflictException('This thread is changing its protection. Try again when that is done.');
    const held = this.recoveryReason(threadId);
    if (held) throw new ConflictException(`${held} Confirm its recovery in the protection control to go on.`);
  }

  /** The session was opened for this generation; a mode change since then disposes it. */
  assertGeneration(threadId: string, generation: number): void {
    this.assertAdmitted(threadId);
    if (this.binding(threadId).generation !== generation)
      throw new ConflictException('The thread’s protection changed. Reopen the thread before running tools.');
  }

  /** Before every sandboxed tool call. */
  assertCurrent(threadId: string, generation: number): void {
    this.assertGeneration(threadId, generation);
    const owner = this.owners.get(`thread:${threadId}`);
    if (owner?.client?.state !== 'active')
      throw new ConflictException(owner?.error ?? owner?.client?.reason ?? 'The sandbox is unavailable.');
  }

  assertHostCapability(threadId: string, capability: string): void {
    this.assertAdmitted(threadId);
    if (this.binding(threadId).mode === 'sandboxed')
      throw new ForbiddenException(`${capability} is unavailable in a sandboxed thread.`);
  }

  /** The thread's sandbox, started if needed; `undefined` in Bypass. */
  async prepare(threadId: string, cwd: string): Promise<SandboxClient | undefined> {
    this.assertAdmitted(threadId);
    const binding = this.binding(threadId);
    return binding.mode === 'sandboxed' ? this.owner(`thread:${threadId}`, cwd, binding) : undefined;
  }

  /** One sandbox per owner (`thread:<id>`, `agent:<id>`), bound to its folder and generation. */
  async owner(ownerId: string, cwd: string, binding: ProtectionBinding): Promise<SandboxClient> {
    const key = JSON.stringify([resolve(cwd), binding.generation, binding.experimentalWindowsAccepted]);
    const existing = this.owners.get(ownerId);
    if (existing && (existing.error === undefined || this.failedCleanup.has(ownerId))) {
      if (existing.key !== key) throw new Error('The sandbox owner changed without stopping first.');
      return existing.ready;
    }
    const held = this.failedCleanup.get(ownerId) ?? (this.store.ownerState(ownerId) ? HELD : undefined);
    if (held) throw new Error(held);
    const owner: Owner = { key, ready: this.start(ownerId, cwd, binding, (client) => (owner.client = client)) };
    owner.ready = owner.ready.catch((error: unknown) => {
      owner.error = ThreadProtectionService.messageOf(error);
      owner.setupRequired = (error as Partial<SandboxError>).code === 'WINDOWS_SETUP_REQUIRED';
      throw error;
    });
    this.owners.set(ownerId, owner);
    return owner.ready;
  }

  /** Disposes the thread's sessions, stops its sandbox and saves the new mode; a sandbox that fails to start leaves it Sandboxed and unavailable. */
  async set(threadId: string, cwd: string, input: SetThreadProtection, dispose: () => void): Promise<ThreadProtection> {
    if (this.changing.has(threadId))
      throw new ConflictException('This thread is changing its protection. Try again when that is done.');
    const previous = this.binding(threadId);
    const held = this.recoveryReason(threadId);
    if (held && input.confirmRecovery !== true)
      throw new ConflictException(`${held} Confirm that it stopped before changing the protection.`);
    if (this.agentGuard?.(threadId))
      throw new ConflictException('Stop this thread’s background agents before changing its protection.');
    if (input.mode === 'bypass' && previous.mode === 'sandboxed' && input.confirmBypass !== true)
      throw new ConflictException('Switching to Bypass needs a confirmation that tools then run on the host.');
    const windowsAccepted = input.experimentalWindowsAccepted ?? previous.experimentalWindowsAccepted;
    if (input.mode === 'sandboxed' && process.platform === 'win32' && !windowsAccepted)
      throw new ConflictException(
        'Sandboxing on Windows is experimental. Accept its network and read-isolation limits first.',
      );
    this.changing.add(threadId);
    try {
      dispose();
      const ownerId = `thread:${threadId}`;
      if (held) await this.acknowledgeRecovery(ownerId);
      else await this.release(ownerId);
      const next: ProtectionBinding = {
        version: 1,
        mode: input.mode,
        generation: previous.generation + 1,
        experimentalWindowsAccepted: windowsAccepted,
      };
      this.store.setBinding(threadId, next);
      if (next.mode === 'sandboxed') await this.owner(ownerId, cwd, next).catch(() => undefined);
      return this.status(threadId);
    } finally {
      this.changing.delete(threadId);
    }
  }

  /** Runs SRT's machine setup on Windows (one administrator prompt), then starts the thread's sandbox again. */
  async setupWindows(threadId: string, cwd: string): Promise<ThreadProtection> {
    if (process.platform !== 'win32') throw new ConflictException('Only Windows needs a sandbox setup.');
    this.assertAdmitted(threadId);
    this.windowsSetup ??= SandboxPackage.load('core')
      .then(({ Sandbox }) => Sandbox.setupWindows())
      .finally(() => (this.windowsSetup = undefined));
    try {
      await this.windowsSetup;
    } catch (error) {
      throw new ConflictException(`The Windows sandbox setup failed: ${ThreadProtectionService.messageOf(error)}`);
    }
    const binding = this.binding(threadId);
    if (binding.mode === 'sandboxed') await this.owner(`thread:${threadId}`, cwd, binding).catch(() => undefined);
    return this.status(threadId);
  }

  /** A fork, clone or import starts in its source's mode, with its own sandbox. */
  copy(sourceId: string, targetId: string): void {
    const source = this.store.binding(sourceId);
    if (source) this.store.setBinding(targetId, { ...source, generation: 0 });
  }

  /** Stops the owner's sandbox; a shutdown that is not confirmed holds the owner for recovery. */
  async release(ownerId: string): Promise<void> {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    await owner.ready.catch(() => undefined);
    try {
      await owner.client?.close();
    } catch (error) {
      this.failedCleanup.set(ownerId, ThreadProtectionService.messageOf(error));
      this.store.setOwnerState(ownerId, 'recovery-required');
      throw error;
    }
    const failed = this.failedCleanup.get(ownerId);
    if (failed && !owner.client) throw new ConflictException(failed);
    this.failedCleanup.delete(ownerId);
    this.store.clearOwner(ownerId);
    if (this.owners.get(ownerId) === owner) this.owners.delete(ownerId);
  }

  /** The owner is gone for good (a removed agent): its sandbox stops and nothing is kept for it. */
  async forget(ownerId: string): Promise<void> {
    await this.release(ownerId);
    this.store.clearOwner(ownerId);
  }

  /** The thread is deleted: its sandbox stops and its mode goes with it. */
  async forgetThread(threadId: string): Promise<void> {
    await this.forget(`thread:${threadId}`);
    this.store.deleteBinding(threadId);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.owners.keys()].map((id) => this.release(id)));
  }

  private async start(
    ownerId: string,
    cwd: string,
    binding: ProtectionBinding,
    started: (client: SandboxClient) => void,
  ): Promise<SandboxClient> {
    const { Sandbox } = await SandboxPackage.load('core');
    this.store.setOwnerState(ownerId, 'starting');
    let client: SandboxClient | undefined;
    try {
      client = await Sandbox.create({
        cwd,
        experimentalWindowsAccepted: binding.experimentalWindowsAccepted,
        protectedPaths: [resolve(this.config.dataDir)],
      });
      started(client);
      if (client.state !== 'active') throw new Error(client.reason ?? 'The sandbox did not start.');
      this.store.setOwnerState(ownerId, 'active');
      return client;
    } catch (error) {
      const confirmed = client
        ? await client.close().then(
            () => true,
            () => false,
          )
        : (error as Partial<SandboxError>).cleanupConfirmed === true;
      if (confirmed) this.store.clearOwner(ownerId);
      else {
        this.failedCleanup.set(ownerId, 'The sandbox failed to start and did not confirm its cleanup.');
        this.store.setOwnerState(ownerId, 'recovery-required');
      }
      throw error;
    }
  }

  /** The person checked that the earlier sandbox stopped: whatever is left of it is closed and forgotten. */
  private async acknowledgeRecovery(ownerId: string): Promise<void> {
    await this.owners
      .get(ownerId)
      ?.client?.close()
      .catch(() => undefined);
    this.owners.delete(ownerId);
    this.failedCleanup.delete(ownerId);
    this.store.clearOwner(ownerId);
  }

  private recoveryReason(threadId: string): string | undefined {
    const ownerId = `thread:${threadId}`;
    return (
      this.failedCleanup.get(ownerId) ??
      (!this.owners.has(ownerId) && this.store.ownerState(ownerId) ? HELD : undefined)
    );
  }

  private stateOf(
    binding: ProtectionBinding,
    owner: Owner | undefined,
    held: string | undefined,
    unavailable: string | undefined,
  ): ThreadProtectionState {
    if (held) return 'recovery-required';
    if (binding.mode === 'bypass') return 'bypass';
    if (unavailable) return owner?.setupRequired ? 'setup-required' : 'unavailable';
    if (!owner) return 'idle';
    if (!owner.client) return 'starting';
    return process.platform === 'win32' ? 'experimental' : 'active';
  }

  private static messageOf(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)) || 'The sandbox failed.';
  }
}
