import { Logger } from '@nestjs/common';
import { type Cycle, type ModelInfo, type ModelList, THINKING_LEVELS, type ThinkingLevel } from '@pi-kit/protocol';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { LiteLlmService } from '../setup/litellm.service';
import { loadPi } from './load-pi';
import { modelProviders } from './model-providers';

export interface SessionModelChange {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  cycle?: Cycle;
}

/** API id of an extension's virtual model (pi's `VIRTUAL_MODEL_API`): it names a router, not a provider's model. */
const VIRTUAL_MODEL_API = 'pi-virtual';

/** The levels a model accepts: pi-ai's `getSupportedThinkingLevels`, which the SDK does not export. A model that does not think has only `off`. */
function supportedLevels(model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** Model discovery, selection and cycling for open sessions, plus the cached lookup for unopened history. */
export class SessionModels {
  private readonly logger = new Logger(SessionModels.name);
  private windowRuntime: Promise<ModelRuntime> | undefined;

  constructor(private readonly liteLlm: LiteLlmService) {}

  /**
   * Models that have credentials (what pi's `/model` lists), the current one, the effort levels it accepts, the cycling scope and the
   * defaults a new thread starts.
   */
  async list(session: AgentSession): Promise<ModelList> {
    // Pick up provider connections and refreshed catalogs saved from Settings in open chats.
    await session.modelRuntime.refresh({ allowNetwork: false });
    await this.liteLlm.refreshCatalog(session.modelRuntime);
    await this.refreshScope(session);
    const available = await session.modelRuntime.getAvailable();
    const scope = this.scope(session);
    const settings = session.settingsManager;
    const defaults = { provider: settings.getDefaultProvider(), id: settings.getDefaultModel(), thinkingLevel: settings.getDefaultThinkingLevel() as ThinkingLevel | undefined };
    const models: ModelInfo[] = available.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      costInput: m.cost?.input,
      costOutput: m.cost?.output,
      levels: supportedLevels(m),
      ...(m.api === VIRTUAL_MODEL_API ? { virtual: true } : {}),
      ...(scope.some((s) => s.model.provider === m.provider && s.model.id === m.id) ? { pinned: true } : {}),
      ...(defaults.provider === m.provider && defaults.id === m.id ? { default: true } : {}),
    }));
    return {
      models,
      providers: modelProviders(session.modelRuntime, available),
      current: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      thinkingLevels: (session.supportsThinking() ? session.getAvailableThinkingLevels() : []) as ThinkingLevel[],
      pinned: scope.map((s) => ({ provider: s.model.provider, id: s.model.id, ...(s.thinkingLevel ? { thinkingLevel: s.thinkingLevel as ThinkingLevel } : {}) })),
      defaults: {
        ...(defaults.provider ? { provider: defaults.provider } : {}),
        ...(defaults.id ? { id: defaults.id } : {}),
        ...(defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel } : {}),
      },
    };
  }

  /** The cycling scope: pi's `enabledModels` setting resolved against the available models, as the CLI passes it to the session. */
  private async refreshScope(session: AgentSession): Promise<void> {
    try {
      await session.settingsManager.reload();
      const patterns = session.settingsManager.getEnabledModels();
      if (!patterns?.length) {
        session.setScopedModels([]);
        return;
      }
      const pi = await loadPi();
      const { scopedModels, diagnostics } = await pi.resolveModelScopeWithDiagnostics(patterns, session.modelRuntime, { signal: AbortSignal.timeout(15_000) });
      for (const d of diagnostics) this.logger.warn(`Model scope: ${d.message}`);
      session.setScopedModels(scopedModels);
    } catch (error) {
      this.logger.warn(`Could not resolve the model scope: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The pinned models that can be used now (credentials present), in cycling order. */
  private scope(session: AgentSession): ReadonlyArray<AgentSession['scopedModels'][number]> {
    const available = new Set(session.modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}\0${m.id}`));
    return session.scopedModels.filter((s) => available.has(`${s.model.provider}\0${s.model.id}`));
  }

  /** `/model` and `/thinking`: switch the model (written to the session file as a model change) and/or the thinking level. */
  async set(session: AgentSession, change: SessionModelChange): Promise<void> {
    if (change.provider && change.modelId) {
      await session.modelRuntime.getAvailable(change.provider);
      const model = session.modelRuntime.getModel(change.provider, change.modelId);
      if (!model) throw new Error(`Unknown model ${change.provider}/${change.modelId}.`);
      await session.setModel(model);
    }
    if (change.thinkingLevel) session.setThinkingLevel(change.thinkingLevel);
    if (change.cycle) await this.cycle(session, change.cycle);
  }

  /**
   * ⌘⇧M / ⌘⇧E: pi's Ctrl+P (`cycleModel`: the pinned models, or every available one when none is pinned) and `cycleThinkingLevel`. Both
   * append their entry to the session file as pi's own keys do. A run that is going keeps the model it started with: pi reads the model when
   * a run begins, so the change applies to the next request.
   */
  async cycle(session: AgentSession, cycle: Cycle): Promise<void> {
    if (cycle.target === 'model') {
      await session.modelRuntime.getAvailable();
      await this.refreshScope(session);
      await session.cycleModel(cycle.direction ?? 'forward');
    } else {
      session.cycleThinkingLevel();
    }
  }

  /**
   * The one place that knows a model's context window (the composer's meter, the status bar and the tree's context rings): pi's model registry for the
   * thread's session, by `provider/id`, or by `id` alone for a turn that recorded no provider. A model pi no longer knows has no window.
   */
  contextWindowLookup(session: AgentSession): (provider: string | undefined, model: string) => number | undefined {
    return (provider, model) =>
      provider ? session.modelRuntime.getModel(provider, model)?.contextWindow : session.modelRuntime.getAvailableSnapshot().find((m) => m.id === model)?.contextWindow;
  }

  /**
   * The context window of a model by `provider/id`, from pi's model registry without opening a session (a thread whose file the sidebar
   * measures). The registry is read once and kept; a model pi does not know has no window.
   */
  async modelWindow(provider: string | undefined, model: string): Promise<number | undefined> {
    const pi = await loadPi();
    this.windowRuntime ??= pi.ModelRuntime.create();
    const runtime = await this.windowRuntime;
    return provider ? runtime.getModel(provider, model)?.contextWindow : runtime.getModels().find((m) => m.id === model)?.contextWindow;
  }
}
