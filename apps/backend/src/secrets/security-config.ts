import { readSecurityPreferences, selectSecretStore, type SecretStore } from '@pi-kit/secret-store';

/** Choose credential storage solely from credential preferences and explicit overrides. */
export function startupSecretStore(dataDir: string, env: NodeJS.ProcessEnv = process.env): SecretStore {
  const preferences = readSecurityPreferences(dataDir);
  const credentialStoreEnabled = preferences?.credentialStoreEnabled;
  const selectedEnv =
    !env['PI_KIT_SECRET_STORE'] && process.platform === 'darwin' && credentialStoreEnabled
      ? { ...env, PI_KIT_SECRET_STORE: preferences?.unattendedKeys ? 'macos-unattended' : 'macos' }
      : env;
  return selectSecretStore(selectedEnv);
}
