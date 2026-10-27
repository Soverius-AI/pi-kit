import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { PiResolution, UpdateRow, UpdateStatus, UpdateTarget } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { piCommandState, installManagedRelease, installPiCommand, piToolEnvironment } from '../pi/managed-install';
import { type Job, cancelJob, createJob, finishStep, nextStep, rowStates, startStep, toJob } from '../pi/update-job';
import { PI_SDK_RANGE, loadPi, piResolution, readPin, writePin } from '../pi/load-pi';
import { PiUpdateService, appVersion } from '../pi/pi-update.service';
import { agentDirOf, inRange, piPackageVersion, previousChoices, resolvePi } from '../pi/pi-resolution';
import { runProcess } from '../pi/process-runner';
import { compareVersions, isNewerVersion } from '../pi/version';

const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const PACKAGES_TIMEOUT_MS = 90_000;
const LOCAL_WATCH_MS = 10_000;

interface StateFile {
  piUpdatedAt?: number;
  packagesUpdatedAt?: number;
  modelsRefreshedAt?: number;
}

/** One package pi says has a newer version or commit. */
export interface PackageUpdateInfo {
  source: string;
  displayName: string;
  type: 'npm' | 'git';
  scope: 'user' | 'project' | 'temporary';
}

export type UpdateListener = (event: { type: 'status'; status: UpdateStatus } | { type: 'line'; target?: UpdateTarget; text: string; at: number }) => void;

/**
 * Updates from inside the app: what is outdated (pi, the installed packages, the model catalogs, pi-kit) and one
 * background job that updates any of them. pi's own updater does the work (`pi update --all`, then `pi update --models`, run from the
 * managed install's release, so the same code as the `pi` command); when there is no managed install the first release is made here
 * (`installManagedRelease`); pi-kit's own update goes through Electron main (`electron-updater`). Output is streamed to the status
 * listeners, written to `update.log`, and shown as each row's progress line. The check runs shortly after launch and every 6 hours, and
 * honours `PI_OFFLINE` and `PI_SKIP_VERSION_CHECK` as pi does.
 */
@Injectable()
export class UpdateService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UpdateService.name);
  private readonly listeners = new Set<UpdateListener>();
  private readonly checked = new Map<UpdateTarget, UpdateRow>();
  private readonly progress = new Map<UpdateTarget, string>();
  private readonly restarts = new Map<'pi' | 'app', string>();
  private job: Job | undefined;
  private abort: AbortController | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private checking = false;
  private restartKey = '[]';
  private checkedAt: number | undefined;
  private appEventsOff: (() => void) | undefined;
  private readonly logPath: string;
  private readonly statePath: string;

  constructor(
    private readonly piUpdate: PiUpdateService,
    private readonly desktop: DesktopBridge,
    @Inject(CONFIG) private readonly config: BackendConfig,
  ) {
    const logDir = process.env['PI_KIT_LOG_DIR'] || join(config.dataDir, 'logs');
    this.logPath = join(logDir, 'update.log');
    this.statePath = join(config.dataDir, 'update-state.json');
  }

  onApplicationBootstrap(): void {
    this.appEventsOff = this.desktop.onAppUpdate((event) => {
      if (event.kind === 'progress') this.progress.set('app', `Downloading pi-kit… ${event.percent}%`);
      else if (event.kind === 'downloaded') this.progress.set('app', `pi-kit ${event.version} downloaded`);
      else if (event.kind === 'error') this.log(`pi-kit update: ${event.message}`, 'app');
      this.publish();
    });
    // An update made elsewhere (the pi command in a terminal) shows up as "restart to use ..." without a new check: this only reads folders.
    const watchMs = Number(process.env['PI_KIT_UPDATE_WATCH_MS']) || LOCAL_WATCH_MS;
    const watch = setInterval(() => {
      const key = JSON.stringify(this.status().restart);
      if (key === this.restartKey) return;
      this.restartKey = key;
      this.publish();
    }, watchMs);
    watch.unref();
    this.timers.push(watch as unknown as ReturnType<typeof setTimeout>);
    const first = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    const every = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every as unknown as ReturnType<typeof setTimeout>);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.appEventsOff?.();
    this.abort?.abort();
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- status

  status(): UpdateStatus {
    const resolution = piResolution();
    const fresh = this.freshResolution();
    const restart: UpdateStatus['restart'] = [];
    if (fresh.version !== resolution.version || fresh.packageDir !== resolution.packageDir) restart.push({ kind: 'pi', version: fresh.version });
    const appRestart = this.restarts.get('app');
    if (appRestart) restart.push({ kind: 'app', version: appRestart });

    const states = this.job ? rowStates(this.job) : {};
    const rows: UpdateRow[] = (['pi', 'packages', 'models', 'app'] as const).map((target) => {
      const base: UpdateRow = this.checked.get(target) ?? { target, state: 'unknown' };
      const overlay = states[target];
      const row: UpdateRow = { ...base, ...(overlay ? { state: overlay } : {}) };
      // A missing app release feed is a skipped target, not an installed update.
      if (target === 'app' && base.state === 'unavailable' && overlay === 'done') row.state = 'unavailable';
      const progress = this.progress.get(target);
      if (overlay === 'running' && progress) row.detail = progress;
      if (overlay === 'failed') {
        const step = this.job?.steps.find((s) => s.targets.includes(target) && s.state === 'failed');
        if (step?.error) row.error = step.error;
      }
      if (target === 'pi' && (!overlay || overlay === 'done') && restart.some((r) => r.kind === 'pi')) {
        row.state = 'done';
        row.current = resolution.version;
        row.detail = `pi ${fresh.version} is installed; restart to use it.`;
      }
      return row;
    });
    const outdated = rows.some((row) => row.state === 'outdated');
    const skipped = process.env['PI_OFFLINE'] ? 'offline' : process.env['PI_SKIP_VERSION_CHECK'] ? 'disabled' : undefined;
    const command = piCommandState(agentDirOf(process.env));
    return {
      rows,
      ...(this.job ? { job: toJob(this.job, this.logPath) } : {}),
      checking: this.checking,
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(skipped ? { skipped } : {}),
      outdated,
      restart,
      resolution,
      ...(fresh.pinned ? { pinned: fresh.pinned } : {}),
      command: { onPath: command.onPath, ...(command.launcherInstalled ? { launcher: command.entrypoint } : {}) },
      desktop: this.desktop.available,
    };
  }

  /** What the resolution would be if the backend started now (it differs from the loaded one after an update or a pin). */
  private freshResolution(): PiResolution {
    const loaded = piResolution();
    const pinned = readPin();
    return resolvePi({ env: process.env, agentDir: agentDirOf(process.env), bundledDir: loaded.bundled.packageDir, range: PI_SDK_RANGE, ...(pinned ? { pinned } : {}) });
  }

  /** The choices for "Use previous release" and whether the next start would use a pin. */
  releases(): { choices: { release: string; label: string }[]; pinned?: string } {
    const fresh = this.freshResolution();
    return { choices: previousChoices(fresh), ...(fresh.pinned ? { pinned: fresh.pinned } : {}) };
  }

  // ---- checks

  async check(force = false): Promise<UpdateStatus> {
    if (this.checking) return this.status();
    this.checking = true;
    this.publish();
    try {
      const skipped = !!(process.env['PI_OFFLINE'] || process.env['PI_SKIP_VERSION_CHECK']);
      const state = this.readState();
      const checks = [this.checkPi(skipped, force), this.checkPackages(skipped, state), this.checkApp(skipped)];
      this.checkModels(state);
      await Promise.all(checks);
      this.checkedAt = Date.now();
    } finally {
      this.checking = false;
      this.publish();
    }
    return this.status();
  }

  private async checkPi(skipped: boolean, force: boolean): Promise<void> {
    const loaded = piResolution();
    const fresh = this.freshResolution();
    // What counts as installed is what the `pi` command runs (the managed install's current release); with no managed install, the copy pi-kit runs.
    const command = fresh.managed?.current;
    const installed = command ?? (compareVersions(fresh.version, loaded.version) === 1 ? fresh.version : loaded.version);
    const base: UpdateRow = { target: 'pi', state: 'unknown', current: loaded.version, updatedAt: this.readState().piUpdatedAt };
    if (skipped) return void this.checked.set('pi', base);
    const check = await this.piUpdate.check(force);
    if (check.error || !check.latest) return void this.checked.set('pi', { ...base, ...(check.error ? { error: check.error } : {}) });
    const outdated = isNewerVersion(check.latest, installed);
    const gate = outdated && !inRange(check.latest, PI_SDK_RANGE) ? ` This pi-kit supports pi up to ${PI_SDK_RANGE.max}; it keeps using ${loaded.version} until pi-kit is updated.` : '';
    const apart = command && command !== loaded.version ? ` The pi command runs ${command}; pi-kit runs ${loaded.version}.` : '';
    this.checked.set('pi', {
      ...base,
      state: outdated ? 'outdated' : 'current',
      latest: check.latest,
      detail: `${outdated ? `pi ${check.latest} is out.` : ''}${apart}${gate}`.trim(),
    });
  }

  private async checkPackages(skipped: boolean, state: StateFile): Promise<void> {
    const base: UpdateRow = { target: 'packages', state: 'unknown', ...(state.packagesUpdatedAt ? { updatedAt: state.packagesUpdatedAt } : {}) };
    if (skipped) return void this.checked.set('packages', base);
    try {
      const names = await withTimeout(this.outdatedPackages(), PACKAGES_TIMEOUT_MS);
      this.checked.set('packages', {
        ...base,
        state: names.length > 0 ? 'outdated' : 'current',
        outdated: names.length,
        items: names,
        detail: names.length > 0 ? names.join(', ') : 'Every installed package is current.',
      });
    } catch (error) {
      this.checked.set('packages', { ...base, error: messageOf(error) });
    }
  }

  private async outdatedPackages(): Promise<string[]> {
    return (await this.packageUpdates()).map((update) => update.displayName);
  }

  /**
   * pi's own check of the installed packages (npm and git; a folder is never behind), as pi reports it. Settings › Extensions and skills › Packages asks for it too, for the user's
   * packages and, with `projectTrusted`, the folder's, so "Check for updates" there and the check here are one question with one answer.
   */
  async packageUpdates(options: { cwd?: string; projectTrusted?: boolean } = {}): Promise<PackageUpdateInfo[]> {
    const pi = await loadPi();
    const agentDir = pi.getAgentDir();
    const cwd = options.cwd ?? this.config.defaultCwd;
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted ?? false });
    const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
    return manager.checkForAvailableUpdates();
  }

  private async checkApp(skipped: boolean): Promise<void> {
    const current = appVersion();
    const base: UpdateRow = { target: 'app', state: 'unknown', current };
    if (!this.desktop.available) return void this.checked.set('app', { ...base, state: 'unavailable', detail: 'pi-kit updates itself in the desktop app.' });
    if (skipped) return void this.checked.set('app', this.checked.get('app') ?? base);
    try {
      const result = await this.desktop.appUpdate('check');
      if (result.unavailable) return void this.checked.set('app', { ...base, state: 'unavailable', detail: result.unavailable });
      this.checked.set('app', result.available ? { ...base, state: 'outdated', latest: result.version, detail: `pi-kit ${result.version} is out.` } : { ...base, state: 'current' });
    } catch (error) {
      this.checked.set('app', { ...base, error: messageOf(error) });
    }
  }

  private checkModels(state: StateFile): void {
    this.checked.set('models', { target: 'models', state: 'current', ...(state.modelsRefreshedAt ? { updatedAt: state.modelsRefreshedAt } : {}) });
  }

  // ---- the job

  start(targets: UpdateTarget[]): UpdateStatus {
    if (this.job?.state === 'running') throw new ConflictException('An update is already running.');
    const unique = [...new Set(targets)];
    const managed = this.managedCurrentDir() !== undefined;
    this.job = createJob(randomUUID(), unique, Date.now(), { managed });
    this.progress.clear();
    this.abort = new AbortController();
    this.log(`Update started: ${unique.join(', ')}${managed ? '' : ' (no managed pi install yet)'}`);
    void this.run(this.job.id, this.abort.signal);
    this.publish();
    return this.status();
  }

  cancel(): UpdateStatus {
    if (this.job?.state === 'running') {
      this.abort?.abort();
      this.job = cancelJob(this.job, Date.now());
      this.log('Update cancelled.');
      this.publish();
    }
    return this.status();
  }

  /** Resolves when the running job has finished (tests, scripts). */
  async idle(): Promise<void> {
    while (this.job?.state === 'running') await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const job = this.job;
      if (!job || job.id !== id) return;
      const index = nextStep(job);
      if (index < 0) break;
      this.job = startStep(job, index);
      this.publish();
      const step = job.steps[index];
      const targets = step.targets;
      let result: Parameters<typeof finishStep>[2];
      try {
        const detail = await this.runStep(step.kind, signal);
        result = { ok: true, ...(detail ? { detail } : {}) };
      } catch (error) {
        result = signal.aborted ? { ok: false, error: 'Cancelled.', cancelled: true } : { ok: false, error: messageOf(error) };
        if (!signal.aborted) this.log(`${step.kind} failed: ${messageOf(error)}`, targets[0]);
      }
      if (this.job?.id !== id || this.job.state !== 'running') break;
      this.job = finishStep(this.job, index, result, Date.now());
      this.publish();
    }
    const finished = this.job;
    if (!finished || finished.id !== id) return;
    this.afterJob(finished);
  }

  private async runStep(kind: Job['steps'][number]['kind'], signal: AbortSignal): Promise<string | undefined> {
    switch (kind) {
      case 'bootstrap-pi': {
        const version = await this.bootstrapVersion();
        this.log(`Installing pi ${version} as pi's managed install…`, 'pi');
        await installManagedRelease({ root: join(agentDirOf(process.env), 'install'), version, signal, log: (line) => this.log(line, 'pi') });
        return `pi ${version} installed`;
      }
      case 'pi-all':
        await this.runPi(['update', '--all'], 'pi', signal);
        return 'pi and packages updated';
      case 'pi-self':
        await this.runPi(['update'], 'pi', signal);
        return 'pi updated';
      case 'packages':
        await this.runPi(['update', '--extensions'], 'packages', signal);
        return 'packages updated';
      case 'models':
        await this.runPi(['update', '--models'], 'models', signal);
        return 'model catalogs refreshed';
      case 'app': {
        const result = await this.desktop.appUpdate('check');
        if (result.unavailable) {
          this.checked.set('app', { target: 'app', state: 'unavailable', current: appVersion(), detail: result.unavailable });
          this.log(`Skipping pi-kit: ${result.unavailable}`, 'app');
          return result.unavailable;
        }
        if (!result.available) return 'pi-kit is up to date';
        this.log(`Downloading pi-kit ${result.version}…`, 'app');
        const done = await this.desktop.appUpdate('download');
        if (done.version) this.restarts.set('app', done.version);
        return `pi-kit ${done.version ?? ''} downloaded`.trim();
      }
    }
  }

  /** What to install when there is no managed install: pi's newest release if this pi-kit supports it, else the bundled version. */
  private async bootstrapVersion(): Promise<string> {
    const bundled = piResolution().bundled.version;
    if (process.env['PI_OFFLINE']) return bundled;
    const check = await this.piUpdate.check(true);
    return check.latest && inRange(check.latest, PI_SDK_RANGE) && isNewerVersion(check.latest, bundled) ? check.latest : bundled;
  }

  /** The active managed release's package folder, when there is an install whose current release is intact. */
  private managedCurrentDir(): { root: string; packageDir: string } | undefined {
    const managed = this.freshResolution().managed;
    const current = managed?.releases.find((release) => release.version === managed.current && release.intact);
    return managed && current ? { root: managed.root, packageDir: join(current.dir, 'node_modules', '@earendil-works', 'pi-coding-agent') } : undefined;
  }

  private async runPi(args: string[], target: UpdateTarget, signal: AbortSignal): Promise<void> {
    const managed = this.managedCurrentDir();
    const packageDir = managed?.packageDir ?? piResolution().bundled.packageDir;
    const bin = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> }).bin?.['pi'] ?? 'dist/bundle/cli.js';
    const env: NodeJS.ProcessEnv = { ...piToolEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
    // These switches suppress background checks. An explicit Update action must
    // still do the requested work; otherwise Pi silently skips package updates.
    delete env['PI_OFFLINE'];
    delete env['PI_SKIP_VERSION_CHECK'];
    // pi's updater updates itself only when it runs from inside a managed install and is told so, as the launcher does.
    if (managed) env['PI_MANAGED_INSTALL_ROOT'] = managed.root;
    else delete env['PI_MANAGED_INSTALL_ROOT'];
    this.log(`$ pi ${args.join(' ')}${managed ? ` (managed release ${piPackageVersion(packageDir)})` : ' (bundled copy)'}`, target);
    const result = await runProcess({
      command: process.execPath,
      args: [join(packageDir, bin), ...args],
      env,
      signal,
      onLine: (line) => this.log(line, target),
    });
    if (result.cancelled) throw new Error('Cancelled.');
    if (result.code !== 0) throw new Error(this.lastError(target) ?? `pi ${args.join(' ')} exited with code ${result.code ?? 'unknown'}`);
  }

  private errors = new Map<UpdateTarget, string>();
  private lastError(target: UpdateTarget): string | undefined {
    return this.errors.get(target);
  }

  /** Re-reads what is installed after a job, records when things were updated, and tells listeners. */
  private afterJob(job: Job): void {
    const state = this.readState();
    const now = Date.now();
    for (const step of job.steps) {
      if (step.state !== 'done') continue;
      if (step.targets.includes('pi')) state.piUpdatedAt = now;
      if (step.targets.includes('packages')) state.packagesUpdatedAt = now;
      if (step.targets.includes('models')) state.modelsRefreshedAt = now;
    }
    this.writeState(state);
    this.log(`Update ${job.state}.`);
    this.publish();
    void this.check(true);
  }

  // ---- the pi command, the pin, the restart

  installCommand(): UpdateStatus {
    if (!this.managedCurrentDir()) throw new ConflictException('There is no managed pi install yet; run Update pi first.');
    const state = installPiCommand(agentDirOf(process.env));
    this.log(`The pi command is set up: ${state.entrypoint}`);
    this.publish();
    return this.status();
  }

  pin(release: string | null): UpdateStatus {
    const offered = this.releases();
    if (release !== null && release !== offered.pinned && !offered.choices.some((choice) => choice.release === release)) throw new ConflictException(`${release} is not a release this pi-kit can switch to.`);
    writePin(release);
    this.log(release ? `Pinned to ${release}.` : 'Pin removed; following the newest compatible pi.');
    this.publish();
    return this.status();
  }

  /** Whether the backend may end itself so that a supervisor (the desktop watchdog) starts it again. */
  get canRestart(): boolean {
    return this.desktop.available || process.env['PI_KIT_ALLOW_RESTART'] === '1';
  }

  /** "Restart to use …": the process ends, the watchdog starts it again on the same port and token, and the threads replay. */
  restart(): void {
    if (!this.canRestart) throw new ConflictException('Restart the backend yourself to use the new pi (pnpm run dev:web).');
    this.log('Restarting the backend.');
    setTimeout(() => process.exit(0), 300);
  }

  /** Installs a downloaded pi-kit update and restarts the app (Electron main quits, installs, relaunches). */
  async installApp(): Promise<void> {
    const result = await this.desktop.appUpdate('install');
    if (!result.downloaded) throw new ConflictException('No pi-kit update has been downloaded.');
  }

  // ---- log, listeners, state file

  private log(text: string, target?: UpdateTarget): void {
    const at = Date.now();
    if (target) {
      this.progress.set(target, text.length > 140 ? `${text.slice(0, 139)}…` : text);
      if (/error/i.test(text)) this.errors.set(target, text.replace(/^Error:\s*/i, ''));
    }
    try {
      mkdirSync(join(this.logPath, '..'), { recursive: true });
      appendFileSync(this.logPath, `${new Date(at).toISOString()} ${target ? `[${target}] ` : ''}${text}\n`);
    } catch {
      // the log is a convenience
    }
    for (const listener of this.listeners) listener({ type: 'line', ...(target ? { target } : {}), text, at });
    if (target) this.publish();
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const event = { type: 'status' as const, status: this.status() };
    for (const listener of this.listeners) listener(event);
  }

  private readState(): StateFile {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as StateFile;
    } catch {
      return {};
    }
  }

  private writeState(state: StateFile): void {
    try {
      mkdirSync(join(this.statePath, '..'), { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify(state)}\n`);
    } catch (error) {
      this.logger.warn(`Could not write ${this.statePath}: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
