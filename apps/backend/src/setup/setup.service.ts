import { mkdirSync, readdirSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { LocalSaveResult, LocalTestResult, OnboardingState, ReadyResult, ScratchFolder, SetupInfo } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { MetaRepository } from '../db/meta.repository';
import { PiConfigService } from '../pi/pi-config.service';
import { PiUpdateService } from '../pi/pi-update.service';
import { agentDirOf } from '../pi/pi-resolution';
import { agentDirFacts, findPathPi, probeLocalServers, proxyHost, testEndpoint } from './detect';
import { providerIdFor, saveLocalProvider } from './local-models';

/**
 * First-run onboarding: `GET /api/setup` says what this machine has (the pi that runs the sessions and the one on PATH, what the agent folder holds,
 * which providers have a usable model, which local servers answer) and whether the flow should open; the other calls are the small steps the cards need that the settings
 * and sign-in endpoints do not already offer. Sign-in itself (Radius, a subscription, an API key) is `POST /api/auth/login` and its stream, as in Settings.
 */
@Injectable()
export class SetupService {
  constructor(
    @Inject(CONFIG) private readonly config: BackendConfig,
    private readonly pi: PiConfigService,
    private readonly updates: PiUpdateService,
    private readonly meta: MetaRepository,
  ) {}

  async detect(): Promise<SetupInfo> {
    const agentDir = agentDirOf(process.env);
    const [about, providers, localServers, pathPi] = await Promise.all([this.updates.about(), this.pi.usableProviders(), probeLocalServers(), findPathPi()]);
    const agent = agentDirFacts(agentDir);
    const proxy = proxyHost();
    return {
      os: { platform: platform(), arch: arch(), release: release() },
      pi: { version: about.pi.version, source: about.pi.source },
      pathPi,
      agentDir: agent,
      providers,
      localServers,
      needsSetup: providers.length === 0,
      existingSetupWorks: providers.length > 0 && agent.exists && (agent.auth.length > 0 || agent.hasModelsJson || agent.sessionCount > 0),
      ...this.onboardingState(),
      autoOpenOff: process.env['PI_KIT_SKIP_ONBOARDING'] === '1',
      ...(proxy ? { proxy } : {}),
    };
  }

  private onboardingState(): { onboarding?: OnboardingState } {
    const value = this.meta.getSetting('onboarding') as Partial<OnboardingState> | undefined;
    return value && (value.state === 'completed' || value.state === 'skipped') && typeof value.at === 'number' ? { onboarding: { state: value.state, at: value.at } } : {};
  }

  setState(state: OnboardingState['state']): OnboardingState {
    const value: OnboardingState = { state, at: Date.now() };
    this.meta.setSetting('onboarding', value);
    return value;
  }

  testLocal(baseUrl: string): Promise<LocalTestResult> {
    return testEndpoint(baseUrl);
  }

  /** Writes the server into pi's `models.json` (the id pi will know it by is the product's name, or the one the card chose). */
  async saveLocal(input: { provider: string; baseUrl: string; models: string[] }): Promise<LocalSaveResult> {
    const tested = await testEndpoint(input.baseUrl);
    if (!tested.ok) throw new Error(`${tested.baseUrl} did not answer: ${tested.error ?? 'no models listed'}`);
    const provider = input.provider || providerIdFor(tested.kind);
    const { path, models } = saveLocalProvider(agentDirOf(process.env), { provider, baseUrl: tested.baseUrl, models: input.models });
    return { provider, models, path };
  }

  /** A fresh empty folder in the data folder to try pi in: `scratch/try-1`, `try-2`, ... */
  scratchFolder(): ScratchFolder {
    const root = join(this.config.dataDir, 'scratch');
    mkdirSync(root, { recursive: true });
    let n = readdirSync(root).filter((name) => /^try-\d+$/.test(name)).length + 1;
    for (;;) {
      const path = join(root, `try-${n}`);
      try {
        mkdirSync(path);
        return { path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        n += 1;
      }
    }
  }

  ready(provider: string, modelId: string): Promise<ReadyResult> {
    return this.pi.ping(provider, modelId);
  }
}
