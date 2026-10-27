import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  type LoginEvent,
  type MoveKeysResult,
  type PatchPiSettings,
  type PiSettings,
  type ProviderInfo,
  type ReadyResult,
  type SettingsModel,
  type SettingsOverview,
  type KeyValidation,
  THINKING_LEVELS,
  keyStorageOf,
  parseResolver,
} from '@pi-kit/protocol';
import { SecretsService } from '../secrets/secrets.service';
import { readMovableKeys } from '../setup/detect';
import { removeConfiguredProvider } from '../setup/local-models';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { loadPi } from './load-pi';
import { createModelRuntime } from './model-runtime';
import { piKeybindings, savePiKeybindings } from './pi-keybindings';
import { PiSessionService } from './pi-session.service';

type Pi = Awaited<ReturnType<typeof loadPi>>;
/** pi's `AuthInteraction` and the prompts and events it carries, taken from the runtime's own signature. */
type Interaction = Parameters<ModelRuntime['login']>[2];
type AuthPrompt = Parameters<Interaction['prompt']>[0];

/** How long a finished login stays available to a client that is still reading it. */
const LOGIN_KEEP_MS = 60_000;

interface PendingPrompt {
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  kind: string;
}

/** One provider sign-in in progress (API key or OAuth), driven by pi's `ModelRuntime.login`. */
export class LoginRun {
  readonly id = randomUUID();
  /** Everything the flow told the client; a stream that connects late replays it. Never holds a secret the user typed. */
  readonly events: LoginEvent[] = [];
  readonly abort = new AbortController();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly listeners = new Set<() => void>();
  done = false;
  /**
   * What happens to a secret the user typed before pi sees it: with a credential store the key is stored there and pi is handed the command that prints it, so the key
   * is never written to `auth.json`. Set by `PiConfigService` for an API-key sign-in; the value comes back out as the answer pi gets, and is not kept here.
   */
  secretFilter?: (value: string) => string | Promise<string>;

  constructor(
    readonly provider: string,
    readonly type: 'api_key' | 'oauth',
  ) {}

  push(event: LoginEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** pi's `AuthInteraction`: prompts wait for `answer()`, events are passed on. */
  interaction(): Interaction & { signal: AbortSignal } {
    return {
      signal: this.abort.signal,
      notify: (event) => {
        switch (event.type) {
          case 'info':
            this.push({ type: 'info', message: event.message, ...(event.links ? { links: event.links.map((l) => ({ ...l })) } : {}) });
            break;
          case 'auth_url':
            this.push({ type: 'auth_url', url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) });
            break;
          case 'device_code':
            this.push({ type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri });
            break;
          case 'progress':
            this.push({ type: 'progress', message: event.message });
            break;
        }
      },
      prompt: (prompt) =>
        new Promise<string>((resolvePrompt, reject) => {
          const promptId = randomUUID();
          this.prompts.set(promptId, { resolve: resolvePrompt, reject, kind: prompt.type });
          prompt.signal?.addEventListener(
            'abort',
            () => {
              if (this.prompts.delete(promptId)) {
                this.push({ type: 'prompt_end', promptId });
                reject(new Error('The question was dismissed.'));
              }
            },
            { once: true },
          );
          this.push({
            type: 'prompt',
            promptId,
            kind: prompt.type,
            message: prompt.message,
            ...('placeholder' in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
            ...(prompt.type === 'select' ? { options: prompt.options.map((o) => ({ ...o })) } : {}),
          });
        }),
    };
  }

  /** Hands the user's answer to pi; false if that question is gone. The value is not kept anywhere here. */
  answer(promptId: string, value: string): boolean {
    const pending = this.prompts.get(promptId);
    if (!pending) return false;
    this.prompts.delete(promptId);
    const finish = async (): Promise<void> => {
      try {
        const answer = pending.kind === 'secret' && this.secretFilter ? await this.secretFilter(value) : value;
        if (this.abort.signal.aborted) pending.reject(new Error('Cancelled.'));
        else pending.resolve(answer);
      } catch (error) {
        pending.reject(error);
      } finally {
        this.push({ type: 'prompt_end', promptId });
      }
    };
    void finish();
    return true;
  }

  cancel(): void {
    this.abort.abort();
    for (const [promptId, pending] of this.prompts) {
      pending.reject(new Error('Sign-in cancelled.'));
      this.push({ type: 'prompt_end', promptId });
    }
    this.prompts.clear();
  }
}

/**
 * pi's global configuration for the settings dialog: `SettingsManager` on the agent directory (never the
 * folder's `.pi/settings.json`, so nothing here needs project trust), the providers and their sign-in through
 * `ModelRuntime`, pi's key bindings and session import. Secrets typed by the user go from the dialog through this
 * service into pi's own `auth.json`; nothing here stores, logs or returns them.
 */
@Injectable()
export class PiConfigService {
  private readonly logger = new Logger(PiConfigService.name);
  private readonly logins = new Map<string, LoginRun>();

  constructor(
    private readonly sessions: PiSessionService,
    /** Keeps API keys in the credential store; absent in tests that do not care, and keys then stay in pi's own `auth.json`. */
    @Optional() private readonly secrets?: SecretsService,
  ) {}

  async overview(cwd: string): Promise<SettingsOverview> {
    const pi = await loadPi();
    const runtime = await createModelRuntime(pi);
    const [providers, models] = await Promise.all([this.providers(pi, runtime), this.models(runtime)]);
    return {
      settings: this.readSettings(pi, cwd),
      providers,
      models,
      keybindings: piKeybindings(pi.getAgentDir()),
      piVersion: pi.VERSION,
    };
  }

  async settings(cwd: string): Promise<PiSettings> {
    return this.readSettings(await loadPi(), cwd);
  }

  async patch(cwd: string, patch: PatchPiSettings): Promise<PiSettings> {
    const pi = await loadPi();
    const manager = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false });
    if (patch.defaultModel) manager.setDefaultModelAndProvider(patch.defaultModel.provider, patch.defaultModel.modelId);
    if (patch.defaultThinkingLevel !== undefined) {
      if (!(THINKING_LEVELS as readonly string[]).includes(patch.defaultThinkingLevel)) {
        throw new Error(`Unknown thinking level "${patch.defaultThinkingLevel}". Use ${THINKING_LEVELS.join(', ')}.`);
      }
      manager.setDefaultThinkingLevel(patch.defaultThinkingLevel as never);
    }
    if (patch.autoCompaction !== undefined) {
      manager.setCompactionEnabled(patch.autoCompaction);
      this.sessions.setAutoCompaction(patch.autoCompaction);
    }
    if (patch.enabledModels !== undefined) manager.setEnabledModels(patch.enabledModels && patch.enabledModels.length > 0 ? patch.enabledModels : undefined);
    if (patch.defaultProjectTrust) manager.setDefaultProjectTrust(patch.defaultProjectTrust);
    if (patch.retryEnabled !== undefined) manager.setRetryEnabled(patch.retryEnabled);
    if (patch.steeringMode) manager.setSteeringMode(patch.steeringMode);
    if (patch.followUpMode) manager.setFollowUpMode(patch.followUpMode);
    if (patch.enableSkillCommands !== undefined) manager.setEnableSkillCommands(patch.enableSkillCommands);
    await manager.flush();
    const errors = manager.drainErrors();
    if (errors.length > 0) throw new Error(`pi could not save its settings: ${errors[0].error.message}`);
    // The open sessions have their own copy of the settings; the ones that change a running session are applied to it.
    this.sessions.applySettings({
      ...(patch.retryEnabled !== undefined ? { retryEnabled: patch.retryEnabled } : {}),
      ...(patch.steeringMode ? { steeringMode: patch.steeringMode } : {}),
      ...(patch.followUpMode ? { followUpMode: patch.followUpMode } : {}),
    });
    return this.readSettings(pi, cwd);
  }

  // ---- sign-in

  /** Starts a sign-in; the client follows it through `run.events` and answers prompts with `answer()`. */
  async startLogin(provider: string, type: 'api_key' | 'oauth', onSignedIn?: () => void, withRuntime?: ModelRuntime): Promise<LoginRun> {
    const pi = await loadPi();
    // `withRuntime` is for tests: a runtime that has a provider registered whose sign-in talks to a mock server.
    const runtime = withRuntime ?? (await pi.ModelRuntime.create());
    const known = runtime.getProvider(provider);
    if (!known) throw new Error(`Unknown provider "${provider}".`);
    const method = type === 'oauth' ? known.auth.oauth : known.auth.apiKey;
    if (!method || !('login' in method) || !method.login) throw new Error(`${known.name} does not offer ${type === 'oauth' ? 'OAuth' : 'API key'} sign-in.`);

    const run = new LoginRun(provider, type);
    if (type === 'api_key' && this.secrets) {
      const secrets = this.secrets;
      run.secretFilter = async (value) => {
        const kept = await secrets.keep(provider, value.trim());
        if (kept.storage === 'auth.json') run.push({ type: 'info', message: `Protected credential storage is disabled or unavailable, so pi keeps the key in auth.json (readable by you only), as a plain-text key.` });
        return kept.value;
      };
    }
    this.logins.set(run.id, run);
    runtime
      .login(provider, type, run.interaction(), { getDeviceId: () => pi.SettingsManager.create(homedir(), pi.getAgentDir(), { projectTrusted: false }).getOrCreateDeviceId() })
      .then(
        () => {
          this.logger.log(`Signed in to ${provider} (${type})`);
          try {
            onSignedIn?.();
          } catch (error) {
            this.logger.warn(`Could not record when ${provider} was signed in: ${error instanceof Error ? error.message : String(error)}`);
          }
          run.push({ type: 'done' });
        },
        (error: unknown) => {
          // The message comes from pi or the provider; it never contains what the user typed.
          run.push({ type: 'error', message: run.abort.signal.aborted ? 'Sign-in cancelled.' : error instanceof Error ? error.message : String(error) });
        },
      )
      .finally(() => {
        run.done = true;
        setTimeout(() => this.logins.delete(run.id), LOGIN_KEEP_MS).unref();
      });
    return run;
  }

  login(id: string): LoginRun | undefined {
    return this.logins.get(id);
  }

  async logout(provider: string): Promise<void> {
    const pi = await loadPi();
    const runtime = await pi.ModelRuntime.create();
    // A key that pi-kit keeps in the credential store goes with the sign-out (what `auth.json` holds is only the command that printed it).
    let kept: boolean;
    try {
      const credential = pi.readStoredCredential(provider, join(pi.getAgentDir(), 'auth.json'));
      kept = credential?.type === 'api_key' && typeof credential.key === 'string' && keyStorageOf(credential.key) === 'keychain';
    } catch {
      kept = false;
    }
    await runtime.logout(provider);
    if (kept) await this.secrets?.forget(provider);
    this.logger.log(`Signed out of ${provider}`);
  }

  /** Remove a saved connection and credential, without touching environment variables or model files. */
  async removeProvider(provider: string): Promise<void> {
    const pi = await loadPi();
    const key = removeConfiguredProvider(pi.getAgentDir(), provider);
    await this.logout(provider);
    // LiteLLM keeps its resolver in models.json rather than auth.json. Only delete this provider's own account.
    if (typeof key === 'string' && parseResolver(key)?.provider === provider) await this.secrets?.forget(provider);
  }

  // ---- reads

  private readSettings(pi: Pi, cwd: string): PiSettings {
    const manager = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false });
    return {
      defaultProvider: manager.getDefaultProvider() ?? null,
      defaultModel: manager.getDefaultModel() ?? null,
      defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? null,
      autoCompaction: manager.getCompactionEnabled(),
      enabledModels: manager.getEnabledModels() ?? null,
      defaultProjectTrust: manager.getDefaultProjectTrust(),
      retryEnabled: manager.getRetryEnabled(),
      steeringMode: manager.getSteeringMode(),
      followUpMode: manager.getFollowUpMode(),
      enableSkillCommands: manager.getEnableSkillCommands(),
      agentDir: pi.getAgentDir(),
    };
  }

  private async providers(pi: Pi, runtime: ModelRuntime): Promise<ProviderInfo[]> {
    const stored = new Map((await runtime.listCredentials()).map((c) => [c.providerId, c.type] as const));
    const authPath = join(pi.getAgentDir(), 'auth.json');
    const out: ProviderInfo[] = [];
    for (const provider of runtime.getProviders()) {
      const methods: ProviderInfo['methods'] = [];
      if (provider.auth.apiKey?.login) methods.push('api_key');
      if (provider.auth.oauth) methods.push('oauth');
      const status = runtime.getProviderAuthStatus(provider.id);
      const storedType = stored.get(provider.id);
      // Providers with no way to sign in and nothing configured are noise (ambient-only cloud providers, say).
      if (methods.length === 0 && !status.configured) continue;
      out.push({
        id: provider.id,
        name: provider.name,
        methods,
        ...(provider.auth.oauth?.isSubscription ? { subscription: true } : {}),
        configured: status.configured,
        ...(status.configured && status.source ? { source: status.source } : {}),
        ...(status.configured && 'label' in status && status.label ? { label: status.label } : {}),
        stored: storedType !== undefined,
        ...(storedType ? { storedType } : {}),
        ...(storedType ? { credential: this.credentialSummary(pi, provider.id, storedType, authPath) } : {}),
      });
    }
    return out.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  }

  private async models(runtime: ModelRuntime): Promise<SettingsModel[]> {
    const available = await runtime.getAvailable();
    return available.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      available: true,
      contextWindow: m.contextWindow,
      ...(m.cost?.input !== undefined ? { costInput: m.cost.input } : {}),
      ...(m.cost?.output !== undefined ? { costOutput: m.cost.output } : {}),
      ...(m.api === 'pi-virtual' ? { virtual: true } : {}),
    }));
  }

  /**
   * What may be shown about a stored credential: its type, where it lives and, for a literal API key, its last four
   * characters. Resolve no credential commands or Keychain entries just to render Settings.
   */
  private credentialSummary(pi: Pi, provider: string, type: 'api_key' | 'oauth', authPath: string): NonNullable<ProviderInfo['credential']> {
    if (type === 'oauth') return { type, store: 'auth.json' };
    let key: string | undefined;
    try {
      const credential = pi.readStoredCredential(provider, authPath);
      key = credential?.type === 'api_key' ? credential.key : undefined;
    } catch {
      key = undefined;
    }
    if (!key) return { type, store: 'auth.json' };
    // Where the secret is: pi's own file, a pi-kit keychain resolver, somebody's command, or an environment variable it names (configuration values, docs/providers.md).
    const store = keyStorageOf(key);
    if (store === 'auth.json') return { type, store, ...(key.length >= 8 ? { lastFour: key.slice(-4) } : {}) };
    return { type, store };
  }

  /**
   * "Move my existing keys into the keychain" (Settings › Providers): every API key that `auth.json` holds in full goes into the credential store and the entry is rewritten, through pi's own
   * login (so pi's lock and format apply), to the command that prints it. One key at a time: a key that cannot be stored, or whose entry cannot be read back as the command, is left as it was
   * (and named in `failed`). Never automatic: `auth.json` may be shared between machines, and the person decides.
   */
  async moveKeys(): Promise<MoveKeysResult> {
    const secrets = this.secrets;
    if (!secrets?.store.available()) throw new Error('There is no credential store on this machine to move the keys into.');
    if (!secrets.credentialsEnabled()) throw new Error('Credential-store storage is disabled. Enable it before moving keys.');
    const pi = await loadPi();
    const runtime = await pi.ModelRuntime.create();
    const authPath = join(pi.getAgentDir(), 'auth.json');
    const result: MoveKeysResult = { moved: [], failed: [] };
    const answering = (value: string): Interaction & { signal: AbortSignal } => ({
      signal: new AbortController().signal,
      notify: () => undefined,
      prompt: async (prompt: AuthPrompt) => {
        if (prompt.type !== 'secret') throw new Error('the provider asks for more than a key');
        return value;
      },
    });
    for (const provider of readMovableKeys(pi.getAgentDir())) {
      let stored = false;
      try {
        const credential = pi.readStoredCredential(provider, authPath);
        if (credential?.type !== 'api_key' || typeof credential.key !== 'string') continue;
        const original = credential.key;
        const kept = await secrets.keep(provider, original);
        if (kept.storage !== 'keychain') throw new Error('the credential store did not take the key');
        stored = true;
        await runtime.login(provider, 'api_key', answering(kept.value));
        const after = pi.readStoredCredential(provider, authPath);
        if (after?.type !== 'api_key' || after.key !== kept.value) {
          await runtime.login(provider, 'api_key', answering(original));
          throw new Error('pi did not write the command into auth.json');
        }
        result.moved.push(provider);
      } catch (error) {
        // Whatever went wrong, the key stays where it was; the copy in the store goes, so nothing is half moved.
        if (stored) await secrets.forget(provider);
        result.failed.push({ provider, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.logger.log(`Moved ${result.moved.length} key(s) into the credential store${result.failed.length > 0 ? `, ${result.failed.length} left in auth.json` : ''}`);
    return result;
  }

  /** The key bindings of pi’s actions with the user’s overrides; `save` writes `keybindings.json` (pi: `/reload` applies it to a running session). */
  async keybindings(): Promise<SettingsOverview['keybindings']> {
    return piKeybindings((await loadPi()).getAgentDir());
  }

  async saveKeybindings(overrides: Record<string, string[]>): Promise<SettingsOverview['keybindings']> {
    return savePiKeybindings((await loadPi()).getAgentDir(), overrides);
  }

  /**
   * The workflow’s last step: one cheap request with the credential pi just stored. It asks the provider’s cheapest model for a single token. A 401
   * or 403 means the provider refused the credential; anything else that goes wrong (no network, no model to ask) is "unchecked", which the dialog
   * says plainly instead of calling the key good or bad.
   */
  async validate(provider: string): Promise<KeyValidation> {
    const pi = await loadPi();
    const runtime = await createModelRuntime(pi);
    const models = (await runtime.getAvailable()).filter((m) => m.provider === provider);
    const sample = models.slice(0, 3).map((m) => m.id);
    const base = { models: models.length, sample };
    if (process.env['PI_OFFLINE']) return { status: 'unchecked', message: 'PI_OFFLINE is set, so no request was made.', ...base };
    const cheapest = [...models].filter((m) => m.api !== 'pi-virtual').sort((a, b) => (a.cost?.input ?? 0) + (a.cost?.output ?? 0) - ((b.cost?.input ?? 0) + (b.cost?.output ?? 0)))[0];
    if (!cheapest) return { status: 'unchecked', message: 'The provider lists no model to ask, so the key could not be tried.', ...base };
    const failed = await this.askOnce(runtime, cheapest, 10_000);
    if (!failed) return { status: 'ok', message: `One request to ${cheapest.provider}/${cheapest.id} succeeded.`, ...base };
    return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api.?key|credential)|forbidden/i.test(failed)
      ? { status: 'rejected', message: `${cheapest.provider} refused the key: ${failed.slice(0, 200)}`, ...base }
      : { status: 'unchecked', message: `The key could not be tried: ${failed.slice(0, 200)}`, ...base };
  }

  /** One request for one token; the provider's or the network's error text, or undefined when it worked. */
  private async askOnce(runtime: ModelRuntime, model: Parameters<ModelRuntime['complete']>[0], timeoutMs: number): Promise<string | undefined> {
    try {
      const reply = await runtime.complete(model, { messages: [{ role: 'user', content: 'Reply with the single word ok.', timestamp: Date.now() }] }, { maxTokens: 8, signal: AbortSignal.timeout(timeoutMs) } as never);
      return reply.stopReason === 'error' ? (reply.errorMessage ?? 'The provider returned an error.') : undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The providers that have at least one model usable right now (a credential, an environment variable, or a `models.json` entry), with how many. */
  async usableProviders(): Promise<{ id: string; name: string; models: number; source?: string }[]> {
    const pi = await loadPi();
    const runtime = await createModelRuntime(pi);
    const counts = new Map<string, number>();
    for (const model of await runtime.getAvailable()) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, models]) => {
        const status = runtime.getProviderAuthStatus(id);
        return { id, name: runtime.getProvider(id)?.name ?? id, models, ...(status.configured && status.source ? { source: status.source } : {}) };
      })
      .sort((a, b) => b.models - a.models || a.name.localeCompare(b.name));
  }

  /**
   * The token a usage source asks the provider with, and whether it is an OAuth subscription token or an API key. pi resolves it (refreshing an OAuth token, running the
   * keychain command of a stored key); the caller uses it for one request and drops it. Nothing here logs it.
   */
  async usageCredential(provider: string): Promise<{ type: 'oauth' | 'api_key'; token: string } | undefined> {
    const pi = await loadPi();
    const runtime = await pi.ModelRuntime.create();
    if (!runtime.getProvider(provider)) return undefined;
    const token = (await runtime.getAuth(provider))?.auth.apiKey;
    return token ? { type: runtime.isUsingOAuth(provider) ? 'oauth' : 'api_key', token } : undefined;
  }

  /** "pi is ready": one cheap request through the model the user will use (the last card of the onboarding). */
  async ping(provider: string, modelId: string): Promise<ReadyResult> {
    const started = Date.now();
    const label = `${provider}/${modelId}`;
    const elapsed = (): number => Date.now() - started;
    const pi = await loadPi();
    const runtime = await createModelRuntime(pi);
    const model = runtime.getModel(provider, modelId);
    if (!model) return { ok: false, model: label, message: `pi does not know the model ${label}.`, ms: elapsed() };
    const failed = await this.askOnce(runtime, model, 30_000);
    return failed ? { ok: false, model: label, message: plainError(failed), ms: elapsed() } : { ok: true, model: label, message: `${label} answered.`, ms: elapsed() };
  }

  /** The absolute path of a session file the user typed (`~/` allowed); it must exist. */
  resolveSessionFile(path: string): string {
    const expanded = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (!existsSync(absolute)) throw new Error(`There is no file at ${absolute}.`);
    return absolute;
  }
}

/** A provider's error as a sentence: `401 {"type":"error","error":{"message":"User not found."}}` becomes `401: User not found.`; other text is cut at 300 characters. */
export function plainError(text: string): string {
  const status = /^\s*(\d{3})\b/.exec(text)?.[1];
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  if (message) return `${status ? `${status}: ` : ''}${message.replace(/\\"/g, '"')}`.slice(0, 300);
  return text.slice(0, 300);
}
