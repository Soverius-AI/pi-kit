import { describe, expect, it, vi } from 'vitest';
import type { SecretsService } from '../secrets/secrets.service';
import type { MetaRepository } from '../db/meta.repository';
import { RoomSlackCredentials } from './room-slack-credentials';
import { RoomTelegramCredentials, RoomTelegramCredentialsSchema } from './room-telegram-credentials';

function fixture() {
  const records = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  const store = {
    kind: 'keychain',
    available: vi.fn(() => true),
    set: vi.fn(async (key: string, value: string) => {
      records.set(key, value);
    }),
    get: vi.fn(async (key: string) => records.get(key) ?? null),
  };
  const enabled = vi.fn(async () => true);
  const meta = {
    getSetting: vi.fn(async (key: string) => metadata.get(key)),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      metadata.set(key, value);
    }),
  };
  const secrets = { store, credentialsEnabled: enabled } as unknown as SecretsService;
  return {
    store,
    records,
    metadata,
    enabled,
    meta,
    telegram: new RoomTelegramCredentials(secrets, meta as unknown as MetaRepository),
    slack: new RoomSlackCredentials(secrets, meta as unknown as MetaRepository),
  };
}
const telegramToken = '123456789:' + 'aB_9-'.repeat(7);

describe('OS-only room bot credentials', () => {
  it('keeps provider records separate and persists only configured flags in application metadata', async () => {
    const f = fixture();
    await Promise.all([f.slack.onModuleInit(), f.telegram.onModuleInit()]);
    expect(f.slack.configured).toBe(false);
    expect(f.telegram.configured).toBe(false);
    const slack = { appToken: 'xapp-' + 'A'.repeat(20), botToken: 'xoxb-' + 'B'.repeat(20) };
    await f.slack.save(slack);
    await f.telegram.save({ botToken: telegramToken });
    expect(await f.slack.read()).toEqual(slack);
    expect(await f.telegram.read()).toEqual({ botToken: telegramToken });
    expect([...f.records.keys()].sort()).toEqual(['rooms.slack', 'rooms.telegram']);
    expect([...f.metadata.entries()].sort()).toEqual([
      ['rooms.slack.configured', true],
      ['rooms.telegram.configured', true],
    ]);
    expect(JSON.stringify([...f.metadata])).not.toContain(telegramToken);
  });
  it('requires an OS store while existing credentials remain readable when new saves are disabled', async () => {
    const f = fixture();
    f.store.kind = 'memory';
    await expect(f.telegram.save({ botToken: telegramToken })).rejects.toThrow('operating system');
    await expect(f.telegram.read()).rejects.toThrow('operating system');
    f.store.kind = 'keychain';
    await f.telegram.save({ botToken: telegramToken });
    f.store.set.mockClear();
    f.meta.setSetting.mockClear();
    f.enabled.mockResolvedValue(false);
    await expect(f.telegram.save({ botToken: telegramToken })).rejects.toThrow('operating system');
    expect(await f.telegram.read()).toEqual({ botToken: telegramToken });
    expect(f.store.set).not.toHaveBeenCalled();
    expect(f.meta.setSetting).not.toHaveBeenCalled();
  });
  it('requires verified atomic storage and redacts malformed stored credentials', async () => {
    const f = fixture();
    f.store.get.mockResolvedValue('not valid JSON ' + telegramToken);
    await expect(f.telegram.save({ botToken: telegramToken })).rejects.toThrow('could not be saved');
    expect(f.telegram.configured).toBe(false);
    expect(f.meta.setSetting).not.toHaveBeenCalled();
    const error = await f.telegram.read().catch((error) => error as Error);
    expect(String(error)).not.toContain(telegramToken);
    expect(String(error)).toContain('credentials are unavailable');
  });
  it('bounds and validates BotFather token syntax before touching storage', async () => {
    const f = fixture();
    for (const botToken of [
      'token',
      '1234:' + 'A'.repeat(35),
      '123456:' + 'A'.repeat(201),
      '123456:' + 'A/'.repeat(20),
    ]) {
      expect(RoomTelegramCredentialsSchema.safeParse({ botToken }).success).toBe(false);
      await expect(f.telegram.save({ botToken })).rejects.toThrow();
    }
    expect(f.store.set).not.toHaveBeenCalled();
    expect(RoomTelegramCredentialsSchema.safeParse({ botToken: telegramToken }).success).toBe(true);
  });
});
