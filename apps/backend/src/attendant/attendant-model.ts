import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AttendantSettings } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { loadPi } from '../pi/load-pi';
import { createModelRuntime } from '../pi/model-runtime';
import type { Prompt } from './attendant-text';

export interface ModelReply {
  text: string;
  /** `provider/id` of the model that answered. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD as pi priced the request. */
  cost: number;
}

/** A model the attendant may use, as `provider/id` with what it costs per million tokens (0 for a local one). */
export interface ModelChoice {
  provider: string;
  id: string;
  /** Input plus output price per million tokens. */
  price: number;
  reasoning: boolean;
}

/** One request a model can answer. A seam, so the attendant's logic is tested without a model. */
export abstract class AttendantModelPort {
  /** Requests made since the backend started. Stays 0 for as long as the attendant is off. */
  abstract readonly calls: number;
  abstract resolve(settings: AttendantSettings): Promise<ModelChoice | undefined>;
  abstract ask(prompt: Prompt, model: ModelChoice, signal?: AbortSignal): Promise<ModelReply>;
}

/** What a request throws when its signal aborted (the caller went away, the attendant was switched off, the backend quits); `AttendantService` answers for it. */
const aborted = (): Error => new Error('The model request was aborted.');

/**
 * The attendant's model access: a pi `AgentSession` of pi-kit's own for every request: no tools, no extensions, no skills, no
 * project files, an in-memory session, thinking off, the request's own system prompt. It is separate from every thread's session, so it never
 * touches a thread's context, trust decisions or files. pi prices the request; the numbers come from the session's own stats.
 * A request has no deadline of its own: it ends with its answer or with its caller's signal, whenever that aborts.
 */
@Injectable()
export class AttendantModel extends AttendantModelPort {
  private readonly logger = new Logger(AttendantModel.name);
  calls = 0;

  constructor(@Inject(CONFIG) private readonly config: Pick<BackendConfig, 'defaultCwd'>) {
    super();
  }

  /** The configured model if pi can use it, else the cheapest one pi can use: price first, then models that do not think, then the id. */
  async resolve(settings: AttendantSettings): Promise<ModelChoice | undefined> {
    const pi = await loadPi();
    const runtime = await createModelRuntime(pi);
    const available = await runtime.getAvailable();
    const choices: ModelChoice[] = available
      .filter((m) => m.api !== 'pi-virtual')
      .map((m) => ({ provider: m.provider, id: m.id, price: (m.cost?.input ?? 0) + (m.cost?.output ?? 0), reasoning: m.reasoning }));
    if (settings.model) {
      const wanted = choices.find((c) => c.provider === settings.model?.provider && c.id === settings.model?.modelId);
      if (wanted) return wanted;
      this.logger.warn(`The attendant's model ${settings.model.provider}/${settings.model.modelId} is not available; using the cheapest one.`);
    }
    return choices.sort((a, b) => a.price - b.price || Number(a.reasoning) - Number(b.reasoning) || a.id.localeCompare(b.id))[0];
  }

  async ask(prompt: Prompt, choice: ModelChoice, signal?: AbortSignal): Promise<ModelReply> {
    // A caller that is gone already costs nothing: no session, and not a request counted.
    if (signal?.aborted) throw aborted();
    this.calls += 1;
    const pi = await loadPi();
    const runtime = await createModelRuntime(pi);
    const model = runtime.getModel(choice.provider, choice.id);
    if (!model) throw new Error(`pi does not know the model ${choice.provider}/${choice.id}.`);
    const cwd = this.config.defaultCwd;
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => prompt.system,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => undefined,
      reload: async () => undefined,
    };
    const { session } = await pi.createAgentSession({
      cwd,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      resourceLoader,
      noTools: 'all',
      sessionManager: pi.SessionManager.inMemory(cwd),
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    const stop = (): void => void session.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      // An abort that landed while pi set the session up came before the listener: nothing is sent for it.
      if (signal?.aborted) throw aborted();
      await session.prompt(prompt.user);
      // `session.abort()` ends the prompt with whatever the model had said so far: an aborted request has no answer.
      if (signal?.aborted) throw aborted();
      const text = session.getLastAssistantText();
      if (!text?.trim()) throw new Error('The model sent no answer.');
      const stats = session.getSessionStats();
      return { text, model: `${choice.provider}/${choice.id}`, inputTokens: stats.tokens.input + stats.tokens.cacheRead, outputTokens: stats.tokens.output, cost: stats.cost };
    } finally {
      signal?.removeEventListener('abort', stop);
      session.dispose();
    }
  }
}
