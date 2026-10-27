import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  secretsCredentialStorage,
  secretsInstall,
  secretsMove,
  secretsProtection,
  secretsRecoveryKey,
  secretsRetry,
  secretsStatus,
  unwrap,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { DatabaseProtection, DiskEncryption, MoveKeysResult, SecretsStatus } from '@pi-kit/protocol';

import { SettingsStore } from './settings.store';

interface SecretsState {
  status: SecretsStatus | undefined;
  protection: { database: DatabaseProtection; disk: DiskEncryption } | undefined;
  moving: boolean;
  moved: MoveKeysResult | undefined;
  installing: boolean;
  /** Where the launcher was installed, and whether that folder is on PATH. */
  installed: { path: string; dir: string; onPath: boolean } | undefined;
  /** The database's recovery key, held only while the dialog that shows it is open. It is never stored, logged or written to the clipboard by this code. */
  recoveryKey: string | undefined;
  recoveryBusy: boolean;
  retrying: boolean;
  storageBusy: boolean;
  storageResult: MoveKeysResult | undefined;
}

/**
 * Secrets at rest in Settings: where keys can be kept and which keys could move there, the one-time move into the keychain, the database's protection and
 * recovery key, the disk-encryption check and the `pi-kit-secret` command on PATH. Redaction is `RedactionStore`. No call here returns an API key; the recovery key is the database's and
 * is held in `recoveryKey` only until the dialog closes.
 */
export const SecretsStore = signalStore(
  { providedIn: 'root' },
  withState<SecretsState>({
    status: undefined,
    protection: undefined,
    moving: false,
    moved: undefined,
    installing: false,
    installed: undefined,
    recoveryKey: undefined,
    recoveryBusy: false,
    retrying: false,
    storageBusy: false,
    storageResult: undefined,
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const settings = inject(SettingsStore);
    const toasts = inject(ToastStore);

    const methods = {
      async setCredentialStorage(enabled: boolean): Promise<boolean> {
        if (store.storageBusy()) return false;
        patchState(store, { storageBusy: true, storageResult: undefined });
        try {
          const storageResult = await unwrap(secretsCredentialStorage({ client: api.client, body: { enabled } }));
          patchState(store, { storageResult });
          await methods.loadStatus();
          await settings.load();
          return true;
        } catch {
          toasts.show('error', translate('settings.advancedSection.storageChangeFailed'));
          await methods.loadStatus();
          return false;
        } finally {
          patchState(store, { storageBusy: false });
        }
      },
      async retryAccess(): Promise<void> {
        if (store.retrying()) return;
        patchState(store, { retrying: true });
        try {
          patchState(store, { status: await unwrap(secretsRetry({ client: api.client })) });
          await settings.load();
          patchState(store, { status: await unwrap(secretsStatus({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.secretsStore.couldNotRetryCredentialAccess', { value1: errorMessage(error) }),
          );
        } finally {
          patchState(store, { retrying: false });
        }
      },
      async loadStatus(): Promise<void> {
        try {
          patchState(store, { status: await unwrap(secretsStatus({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.secretsStore.couldNotReadWhereSecretsAreKept', { value1: errorMessage(error) }),
          );
        }
      },

      async loadProtection(): Promise<void> {
        try {
          patchState(store, { protection: await unwrap(secretsProtection({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.secretsStore.couldNotReadTheDatabaseProtection', { value1: errorMessage(error) }),
          );
        }
      },

      /** "Move my existing keys into the keychain": only on a click; every key that moved or stayed is reported, and the provider list is read again. */
      async moveKeys(): Promise<void> {
        patchState(store, { moving: true, moved: undefined });
        try {
          const moved = await unwrap(secretsMove({ client: api.client }));
          patchState(store, { moved });
          await settings.load();
          patchState(store, { status: await unwrap(secretsStatus({ client: api.client })) });
          if (moved.failed.length > 0)
            toasts.show(
              'warning',
              translate(
                moved.failed.length === 1
                  ? 'settings.secretsStore.moveFailed.one'
                  : 'settings.secretsStore.moveFailed.other',
                { count: moved.failed.length },
              ),
            );
        } catch (error) {
          toasts.show('error', translate('settings.secretsStore.couldNotMoveTheKeys', { value1: errorMessage(error) }));
        } finally {
          patchState(store, { moving: false });
        }
      },

      dismissMoved(): void {
        patchState(store, { moved: undefined });
      },

      /** Puts `pi-kit-secret` on PATH (a launcher in `~/.local/bin`); only on a click. */
      async installCli(): Promise<void> {
        patchState(store, { installing: true });
        try {
          patchState(store, { installed: await unwrap(secretsInstall({ client: api.client })) });
          patchState(store, { status: await unwrap(secretsStatus({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.secretsStore.couldNotInstallPiKitSecret', { value1: errorMessage(error) }),
          );
        } finally {
          patchState(store, { installing: false });
        }
      },

      /** "Export recovery key": the backend gives it once; this holds it for the dialog and nothing else. */
      async showRecoveryKey(): Promise<void> {
        patchState(store, { recoveryBusy: true });
        try {
          const { key } = await unwrap(secretsRecoveryKey({ client: api.client }));
          patchState(store, { recoveryKey: key });
          void methods.loadProtection();
        } catch (error) {
          toasts.show('warning', errorMessage(error));
        } finally {
          patchState(store, { recoveryBusy: false });
        }
      },

      closeRecoveryKey(): void {
        patchState(store, { recoveryKey: undefined });
      },
    };
    return methods;
  }),
);
export type SecretsStore = InstanceType<typeof SecretsStore>;
