import { describe, expect, it, vi } from 'vitest';
import { OnboardingStateRequestSchema } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { ContractValidationPipe } from '../contract/pipe';
import type { MetaRepository } from '../db/meta.repository';
import type { PiConfigService } from '../pi/pi-config.service';
import type { PiUpdateService } from '../pi/pi-update.service';
import { SetupService } from './setup.service';

vi.mock('./detect', () => ({
  agentDirFacts: () => ({
    path: '/test/agent',
    exists: false,
    auth: [],
    hasModelsJson: false,
    hasSettings: false,
    sessionCount: 0,
  }),
  findPathPi: async () => ({ found: false }),
  probeLocalServers: async () => [],
  proxyHost: () => undefined,
}));

function fixture() {
  const values = new Map<string, unknown>();
  const meta = {
    getSetting: vi.fn((key: string) => values.get(key)),
    setSetting: vi.fn((key: string, value: unknown) => values.set(key, value)),
  };
  const pi = { usableProviders: vi.fn(async () => []) };
  const updates = { about: vi.fn(async () => ({ pi: { version: 'test', source: 'bundled' } })) };
  const service = () =>
    new SetupService(
      { dataDir: '/test/data' } as BackendConfig,
      pi as unknown as PiConfigService,
      updates as unknown as PiUpdateService,
      meta as unknown as MetaRepository,
    );
  return { service, meta, values };
}

describe('onboarding completion', () => {
  it.each(['completed', 'skipped'] as const)(
    'records only the %s flag and returns it on later detection',
    async (state) => {
      const f = fixture();
      const value = f.service().setState(state);
      expect(value).toEqual({ state, at: expect.any(Number) });
      expect(f.meta.setSetting).toHaveBeenCalledExactlyOnceWith('onboarding', value);
      expect([...f.values.keys()]).toEqual(['onboarding']);
      // A newly constructed service sees the saved state; no provider or credential setup is required.
      expect((await f.service().detect()).onboarding).toEqual(value);
    },
  );

  it.each([
    undefined,
    {},
    { state: 'reset' },
    { state: 'completed', provider: 'injected' },
    { state: 'skipped', credentialStoreEnabled: true },
    { state: 'completed', at: 0 },
  ])('rejects malformed or administrative fields at the request-validation boundary: %j', async (body) => {
    const pipe = new ContractValidationPipe();
    await expect(pipe.transform(body, { type: 'body', schema: OnboardingStateRequestSchema })).rejects.toMatchObject({
      status: 400,
    });
  });
});
