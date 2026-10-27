import { setTimeout as delay } from 'node:timers/promises';
import { BadRequestException, ConflictException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ManagedLlamaSwap } from '@pi-kit/protocol';
import { z } from 'zod';
import { MetaRepository } from '../db/meta.repository';
import { runProcess } from '../pi/process-runner';
import { localExecutable } from './local-hardware.service';
import { readLlamaSwapModels } from './local-llama-swap-config';
import { LocalLlamaSwapService } from './local-llama-swap.service';

const AutostartSchema = z.object({ configPath: z.string().min(1), listen: z.string().min(1) }).strict();
const LOG_LINES = 120;
const READY_MS = 20_000;

interface Running {
  configPath: string;
  listen: string;
  abort: AbortController;
  done: Promise<void>;
  pid?: number;
  startedAt: number;
}

/**
 * The llama-swap process pi-kit starts for the selected config, so a stopped one still shows in the add-provider wizard and can be
 * added. pi-kit starts the installed `llama-swap` with the user's own config on the loopback listener, owns that process (it ends with the backend), and never touches
 * a llama-swap it did not start: when something already answers on the listener, Start refuses and says so.
 */
@Injectable()
export class LocalLlamaSwapProcessService implements OnModuleDestroy {
  private readonly logger = new Logger(LocalLlamaSwapProcessService.name);
  private active?: Running;
  private starting = false;
  private destroyed = false;
  private error?: string;
  private log: string[] = [];
  private tool?: string;
  private configModels = 0;
  private listenerBusy?: { at: number; busy: boolean };
  /** Told once the process answers (the providers learn its models) and once it is gone. */
  private readonly listeners = new Set<(state: ManagedLlamaSwap['state']) => void>();

  constructor(private readonly swap: LocalLlamaSwapService, private readonly meta: MetaRepository) {}

  onChange(listener: (state: ManagedLlamaSwap['state']) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Where the managed process listens: `PI_KIT_LLAMA_SWAP_LISTEN` (the tests), else the saved choice, else llama-swap's own default. */
  listen(): string {
    const saved = this.meta.getSetting('local-runtime-listen');
    return process.env['PI_KIT_LLAMA_SWAP_LISTEN'] || (typeof saved === 'string' && saved ? saved : '127.0.0.1:8080');
  }
  baseUrl(listen = this.listen()): string { return `http://${listen}/v1`; }
  isRunning(): boolean { return !!this.active && !this.starting; }
  autostart(): boolean { return AutostartSchema.safeParse(this.meta.getSetting('local-runtime-autostart')).success; }

  /** Rereads what Start depends on (cheap, bounded) so `status()` can stay synchronous. */
  async refresh(): Promise<void> {
    this.tool = await localExecutable('llama-swap');
    const configs = await this.swap.readConfigs().catch(() => []);
    this.configModels = configs.find((config) => config.selected)?.models.length ?? 0;
    if (!this.active && (!this.listenerBusy || Date.now() - this.listenerBusy.at > 5000)) this.listenerBusy = { at: Date.now(), busy: await answers(this.baseUrl()) };
  }

  status(): ManagedLlamaSwap {
    const configPath = this.active?.configPath ?? this.swap.status().engine.configPath;
    const listen = this.active?.listen ?? this.listen();
    const state: ManagedLlamaSwap['state'] = this.active ? (this.starting ? 'starting' : 'running') : this.error ? 'failed' : 'stopped';
    const reason = this.active ? undefined : !this.tool ? 'Install llama-swap first (Engines).' : !configPath ? 'Choose a llama-swap config in Engines first.' : this.configModels === 0 ? 'The config has no models yet.' : this.listenerBusy?.busy ? `Something already answers on ${listen}: use that server, or stop it first.` : undefined;
    return {
      state, configPath, listen, baseUrl: this.baseUrl(listen), log: this.log,
      ...(this.active?.pid ? { pid: this.active.pid } : {}), ...(this.active ? { startedAt: this.active.startedAt } : {}), ...(this.error ? { error: this.error } : {}),
      canStart: !this.active && !reason, ...(reason ? { reason } : {}),
    };
  }

  /** Starts llama-swap with the config and waits until `/v1/models` answers; refuses while another one answers on the listener. */
  async start(input: { configPath?: string; autostart?: boolean }): Promise<ManagedLlamaSwap> {
    if (this.destroyed) throw new ConflictException('The app is shutting down.');
    if (this.active) throw new ConflictException('llama-swap is already running. Stop it before starting it again.');
    const tool = await localExecutable('llama-swap');
    if (!tool) throw new BadRequestException('Install llama-swap first (Engines › Set up).');
    const configPath = input.configPath ?? this.swap.status().engine.configPath;
    if (!configPath) throw new BadRequestException('Choose a llama-swap config in Engines first.');
    let models: string[];
    try { models = await readLlamaSwapModels(configPath); }
    catch (error) { throw new BadRequestException(`The config cannot be used: ${error instanceof Error ? error.message : String(error)} Repair it or edit it in Advanced YAML.`); }
    if (models.length === 0) throw new BadRequestException('The config has no models yet. Add one in Your models first.');
    const listen = this.listen();
    if (await answers(this.baseUrl(listen))) throw new ConflictException(`Something already answers on ${listen}: use that server in the add-provider wizard, or stop it first.`);
    this.tool = tool;
    this.error = undefined;
    this.log = [];
    const active: Running = { configPath, listen, abort: new AbortController(), done: Promise.resolve(), startedAt: Date.now() };
    this.active = active;
    this.starting = true;
    active.done = runProcess({
      command: tool, args: ['-config', configPath, '-listen', listen, '-watch-config'], processGroup: true, signal: active.abort.signal,
      onStart: (pid) => { active.pid = pid; },
      onLine: (line) => { this.log = [...this.log, line.slice(0, 1000)].slice(-LOG_LINES); },
    }).then((result) => {
      if (!active.abort.signal.aborted) this.error = `llama-swap stopped on its own (${result.code ?? result.signal}). See its last lines below, then start it again.`;
    }).catch((error: unknown) => {
      if (!active.abort.signal.aborted) this.error = error instanceof Error ? error.message : 'llama-swap could not be started.';
    }).finally(() => {
      if (this.active === active) { this.active = undefined; this.starting = false; }
      this.listenerBusy = undefined;
      for (const listener of this.listeners) listener('stopped');
    });
    try {
      const deadline = Date.now() + READY_MS;
      while (Date.now() < deadline) {
        if (this.active !== active) throw new Error(this.error ?? 'llama-swap stopped before it answered.');
        if (await answers(this.baseUrl(listen))) break;
        await delay(200);
      }
      if (this.active !== active) throw new Error(this.error ?? 'llama-swap stopped before it answered.');
      if (Date.now() >= deadline) throw new Error(`llama-swap did not answer on ${listen} within ${READY_MS / 1000} s. See its last lines below.`);
    } catch (error) {
      await this.stop();
      this.error = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(this.error);
    }
    this.starting = false;
    this.listenerBusy = undefined;
    if (input.autostart !== undefined) this.meta.setSetting('local-runtime-autostart', input.autostart ? { configPath, listen } : null);
    this.logger.log(`llama-swap ${active.pid ?? ''} started with ${configPath} on ${listen}`);
    for (const listener of this.listeners) listener('running');
    return this.status();
  }

  /** Ends the process pi-kit started (SIGTERM, then SIGKILL after 5 s, the whole group) and forgets the autostart choice. */
  async stop(): Promise<ManagedLlamaSwap> {
    const active = this.active;
    if (active) {
      this.active = undefined;
      this.starting = false;
      active.abort.abort();
      await active.done;
      this.logger.log(`llama-swap ${active.pid ?? ''} stopped`);
    }
    this.meta.setSetting('local-runtime-autostart', null);
    return this.status();
  }

  /** "Start llama-swap when pi-kit starts": the choice on its own, for the running process or the selected config. */
  setAutostart(enabled: boolean): void {
    const configPath = this.active?.configPath ?? this.swap.status().engine.configPath;
    if (enabled && !configPath) throw new BadRequestException('Choose a llama-swap config in Engines first.');
    this.meta.setSetting('local-runtime-autostart', enabled ? { configPath, listen: this.active?.listen ?? this.listen() } : null);
  }

  /** The saved choice "start llama-swap with pi-kit": started once the backend is up, when nothing else answers on the listener. */
  async startSaved(): Promise<void> {
    const saved = AutostartSchema.safeParse(this.meta.getSetting('local-runtime-autostart'));
    if (!saved.success) { if (this.meta.getSetting('local-runtime-autostart')) this.meta.setSetting('local-runtime-autostart', null); return; }
    try { await this.start({ configPath: saved.data.configPath }); }
    catch (error) { this.logger.warn(`llama-swap did not start with the app: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.abort.abort();
    await active.done;
  }
}

/** Does an OpenAI-compatible server answer there? A bounded GET of the model list; anything but a 2xx is "no". */
async function answers(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(800) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
