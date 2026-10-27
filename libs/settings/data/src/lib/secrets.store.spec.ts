import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  secretsCredentialStorage,
  secretsInstall,
  secretsMove,
  secretsProtection,
  secretsRecoveryKey,
  secretsRetry,
  secretsStatus,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { SecretsStatus } from '@pi-kit/protocol';

import { SecretsStore } from './secrets.store';
import { SettingsStore } from './settings.store';

const status = (over: Partial<SecretsStatus> = {}): SecretsStatus => ({
  store: 'keychain',
  label: 'macOS Keychain',
  available: true,
  movable: ['openrouter'],
  cliOnPath: false,
  cliNeeded: false,
  ...over,
});

describe('SecretsStore', () => {
  const api = {
    status: vi.fn(),
    protection: vi.fn(),
    moveKeys: vi.fn(),
    installCli: vi.fn(),
    recoveryKey: vi.fn(),
    retry: vi.fn(),
    storage: vi.fn(),
  };
  const settings = { load: vi.fn(async () => undefined), overview: signal(undefined) };
  const make = () => {
    const store = TestBed.inject(SecretsStore);
    TestBed.tick();
    return store;
  };

  beforeEach(() => {
    for (const call of Object.values(api)) call.mockReset();
    settings.load.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: settings },
        ...provideMockApi([
          [secretsStatus, api.status, () => []],
          [secretsProtection, api.protection, () => []],
          [secretsMove, api.moveKeys, () => []],
          [secretsInstall, api.installCli, () => []],
          [secretsRecoveryKey, api.recoveryKey, () => []],
          [secretsRetry, api.retry, () => []],
          [secretsCredentialStorage, api.storage, (o) => [o.body?.['enabled']]],
        ]),
      ],
    });
  });

  it('changes credential storage explicitly, reports unreadable references and refreshes provider status', async () => {
    api.storage.mockResolvedValueOnce({ moved: ['litellm'], failed: [{ provider: 'groq', reason: 'Re-enter it' }] });
    api.status.mockResolvedValueOnce(status({ credentialsEnabled: false, available: false }));
    const store = make();
    expect(api.storage).not.toHaveBeenCalled();
    expect(await store.setCredentialStorage(false)).toBe(true);
    expect(api.storage).toHaveBeenCalledWith(false);
    expect(store.storageResult()?.failed[0].provider).toBe('groq');
    expect(store.status()?.credentialsEnabled).toBe(false);
    expect(settings.load).toHaveBeenCalledOnce();
    expect(store.storageBusy()).toBe(false);
  });

  it('reads where secrets can be kept and which keys could move there', async () => {
    api.status.mockResolvedValueOnce(status());
    const store = make();
    await store.loadStatus();
    expect(store.status()?.movable).toEqual(['openrouter']);
    expect(api.status).toHaveBeenCalledOnce();
  });

  it('retries only when asked and shows the access result after refreshing providers', async () => {
    api.status.mockResolvedValueOnce(status({ access: { state: 'denied', reason: 'Access was denied' } }));
    const store = make();
    await store.loadStatus();
    expect(api.retry).not.toHaveBeenCalled();
    api.retry.mockResolvedValueOnce(status({ access: { state: 'unknown' } }));
    api.status.mockResolvedValueOnce(status({ access: { state: 'ready' } }));
    await store.retryAccess();
    expect(settings.load).toHaveBeenCalledOnce();
    expect(store.status()?.access?.state).toBe('ready');
    expect(store.retrying()).toBe(false);
  });

  it('moves the keys only when asked, reports what moved and what stayed, and reads the providers again', async () => {
    api.moveKeys.mockResolvedValueOnce({
      moved: ['openrouter'],
      failed: [{ provider: 'groq', reason: 'the credential store did not take the key' }],
    });
    api.status.mockResolvedValueOnce(status({ movable: [] }));
    const store = make();
    const toasts = TestBed.inject(ToastStore);
    await store.moveKeys();
    expect(api.moveKeys).toHaveBeenCalledOnce();
    expect(store.moved()).toEqual({
      moved: ['openrouter'],
      failed: [{ provider: 'groq', reason: 'the credential store did not take the key' }],
    });
    expect(settings.load).toHaveBeenCalledOnce();
    expect(store.status()?.movable).toEqual([]);
    expect(store.moving()).toBe(false);
    expect(toasts.items()[0].text).toMatch(/1 key could not be moved/);
    store.dismissMoved();
    expect(store.moved()).toBeUndefined();
  });

  it('says why a move failed and stops waiting', async () => {
    api.moveKeys.mockRejectedValueOnce(
      new Error('There is no credential store on this machine to move the keys into.'),
    );
    const store = make();
    const toasts = TestBed.inject(ToastStore);
    await store.moveKeys();
    expect(store.moving()).toBe(false);
    expect(toasts.items()[0].text).toMatch(/no credential store/);
  });

  it('holds the recovery key only until its dialog closes, and says when it was shown before', async () => {
    api.recoveryKey.mockResolvedValueOnce({ key: 'a'.repeat(64) });
    api.protection.mockResolvedValueOnce({
      database: { state: 'encrypted', path: '/d', recoveryKeyShown: true },
      disk: { state: 'on', mechanism: 'FileVault', detail: '' },
    });
    const store = make();
    await store.showRecoveryKey();
    expect(store.recoveryKey()).toBe('a'.repeat(64));
    store.closeRecoveryKey();
    expect(store.recoveryKey()).toBeUndefined();
    api.recoveryKey.mockRejectedValueOnce(new Error('The recovery key was shown once already and is not shown again.'));
    await store.showRecoveryKey();
    expect(store.recoveryKey()).toBeUndefined();
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toMatch(/not shown again/);
  });

  it('installs pi-kit-secret on PATH on a click and reports where', async () => {
    api.installCli.mockResolvedValueOnce({
      path: '/home/a/.local/bin/pi-kit-secret',
      dir: '/home/a/.local/bin',
      onPath: true,
    });
    api.status.mockResolvedValueOnce(status({ cliOnPath: true }));
    const store = make();
    await store.installCli();
    expect(store.installed()).toEqual({
      path: '/home/a/.local/bin/pi-kit-secret',
      dir: '/home/a/.local/bin',
      onPath: true,
    });
    expect(store.status()?.cliOnPath).toBe(true);
    expect(store.installing()).toBe(false);
  });
});
