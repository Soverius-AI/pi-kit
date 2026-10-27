import { z } from 'zod';

/**
 * Secrets at rest: the names pi-kit's credential entries have, the `!command` strings written into pi's `auth.json` so that
 * the pi command line can resolve a keychain-held key without pi-kit running, and how such a string is recognised again. Pure: no I/O, so the unit
 * tests cover every platform.
 */

/** The service name of every entry pi-kit keeps in the operating system's credential store. */
export const SECRET_SERVICE = 'pi-kit';
/** Accounts that begin with this are pi-kit's own (the database key); every other account is a provider id. */
export const INTERNAL_ACCOUNT_PREFIX = 'pi-kit/';
/** The account of the database key (`pi-kit/db`). */
export const DB_KEY_ACCOUNT = `${INTERNAL_ACCOUNT_PREFIX}db`;

/** What a provider id may look like to be kept in the keychain (and written into a command without quoting). */
const PROVIDER_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isProviderAccount = (provider: string): boolean => PROVIDER_ACCOUNT.test(provider);

export type ResolverPlatform = 'darwin' | 'win32' | 'linux';
export type ResolverVia = 'security' | 'secret-tool' | 'pi-kit-secret';

/**
 * The command pi runs to get the key (`!<command>` in `auth.json`), chosen so that the pi CLI keeps working without pi-kit running:
 *  - macOS: `security`, which ships with the system. It addresses the entry by service and account, as the keyring package wrote it.
 *  - Linux: `secret-tool` when libsecret's tool is installed, else `pi-kit-secret`.
 *  - Windows: `pi-kit-secret` (Credential Manager through the helper).
 */
export function resolverCommand(platform: ResolverPlatform, provider: string, options: { secretTool?: boolean } = {}): string {
  if (!isProviderAccount(provider)) throw new Error(`"${provider}" is not a name the keychain entry can carry.`);
  if (platform === 'darwin') return `!security find-generic-password -s ${SECRET_SERVICE} -a ${provider} -w`;
  if (platform === 'linux' && options.secretTool) return `!secret-tool lookup service ${SECRET_SERVICE} username ${provider}`;
  return `!pi-kit-secret get ${provider}`;
}

/**
 * The `Authorization` header value a connector's `mcp.json` entry holds instead of a token, made from the resolver the token's account has (`resolverCommand`): pi runs it when
 * the server connects, and the whole value must be the command (mcp.md, "Configuration rules"). Where the store is read with a system tool the command wraps its output in
 * `echo Bearer $(...)`; where the helper is the resolver (Windows, which has no `$( )` in its shell) the helper prints the header itself (`--bearer`).
 */
export function bearerFromResolver(resolver: string): string {
  return resolver.startsWith('!pi-kit-secret get ') ? `${resolver} --bearer` : `!echo Bearer $(${resolver.slice(1)})`;
}

/** The account a connector's token is kept under. */
export const connectorAccount = (id: string): string => `connector-${id}`;

/** The account a connector's OAuth client secret is kept under (`oauth-client` connectors). */
export const connectorSecretAccount = (id: string): string => `connector-${id}-secret`;

const RESOLVERS: readonly { via: ResolverVia; pattern: RegExp }[] = [
  { via: 'security', pattern: /^!security find-generic-password -s pi-kit -a ([A-Za-z0-9][A-Za-z0-9._-]*) -w$/ },
  { via: 'secret-tool', pattern: /^!secret-tool lookup service pi-kit username ([A-Za-z0-9][A-Za-z0-9._-]*)$/ },
  { via: 'pi-kit-secret', pattern: /^!pi-kit-secret get ([A-Za-z0-9][A-Za-z0-9._-]*)$/ },
];

/** Whether an `auth.json` key is one of pi-kit's resolvers, and for which provider; anything else starting with `!` is somebody's own command. */
export function parseResolver(key: string): { provider: string; via: ResolverVia } | undefined {
  for (const { via, pattern } of RESOLVERS) {
    const match = pattern.exec(key);
    if (match) return { provider: match[1], via };
  }
  return undefined;
}

/** `auth.json`'s `key` field of an API-key credential, by where the secret itself is. */
export type KeyStorage = 'keychain' | 'command' | 'environment' | 'auth.json';

/** pi lets a key be the name of an environment variable (configuration values, providers.md). */
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;

export function keyStorageOf(key: string): KeyStorage {
  if (key.startsWith('!')) return parseResolver(key) ? 'keychain' : 'command';
  if (ENV_NAME.test(key)) return 'environment';
  return 'auth.json';
}

// ---- the secret store's reports

export const SecretStoreKindSchema = z.enum(['keychain', 'file', 'memory', 'none']);
export type SecretStoreKind = z.infer<typeof SecretStoreKindSchema>;

export const CredentialAccessSchema = z.object({
  state: z.enum(['unknown', 'ready', 'locked', 'denied', 'unavailable', 'failed']),
  reason: z.string().optional(),
});
export type CredentialAccess = z.infer<typeof CredentialAccessSchema>;

/** What Settings › Providers and › Advanced say about where secrets can be kept. */
export const SecretsStatusSchema = z.object({
  /** The OS credential store (`keychain`), a scratch store for tests (`file`, `memory`), or none. */
  store: SecretStoreKindSchema,
  /** The store's name in words: "macOS Keychain", "Windows Credential Manager", "Secret Service (libsecret)". */
  label: z.string(),
  available: z.boolean(),
  /** User preference for API keys and connector secrets; database encryption is independent. */
  credentialsEnabled: z.boolean().optional(),
  /** Native capability and actual credential access are separate: status never probes the store. */
  access: CredentialAccessSchema.optional(),
  /** `auth.json` entries that hold a literal key and could be moved into the store (provider ids). */
  movable: z.array(z.string()),
  /** The resolver the next key will be written as, or undefined without a store. */
  resolver: z.string().optional(),
  /** `pi-kit-secret` is on PATH (needed by the Windows resolver, and by Linux without `secret-tool`). */
  cliOnPath: z.boolean(),
  /** Where `pi-kit-secret` would be installed on PATH by the "Install" button. */
  cliInstallDir: z.string().optional(),
  /** The command the pi CLI needs on PATH, when the resolver uses it and it is missing. */
  cliNeeded: z.boolean(),
}).meta({ id: 'SecretsStatus' });
export type SecretsStatus = z.infer<typeof SecretsStatusSchema>;

export const CredentialStorageSchema = z.object({ enabled: z.boolean() }).strict().meta({ id: 'CredentialStorage' });

/** What the Advanced section shows about the database file. */
export const DatabaseProtectionSchema = z.object({
  /** `encrypted`: SQLCipher with the key in the credential store; `plain`: no store, or the native module is not the encrypting build. */
  state: z.enum(['encrypted', 'plain']),
  path: z.string(),
  reason: z.string().optional(),
  /** The recovery key was shown once already (Settings never shows it again). */
  recoveryKeyShown: z.boolean(),
}).meta({ id: 'DatabaseProtection' });
export type DatabaseProtection = z.infer<typeof DatabaseProtectionSchema>;

export const DiskEncryptionSchema = z.object({
  /** `on`, `off`, or `unknown` when the check could not run. */
  state: z.enum(['on', 'off', 'unknown']),
  /** FileVault, BitLocker or LUKS. */
  mechanism: z.string(),
  detail: z.string(),
}).meta({ id: 'DiskEncryption' });
export type DiskEncryption = z.infer<typeof DiskEncryptionSchema>;

export const MoveKeysResultSchema = z.object({ moved: z.array(z.string()), failed: z.array(z.object({ provider: z.string(), reason: z.string() })) }).meta({ id: 'MoveKeysResult' });
export type MoveKeysResult = z.infer<typeof MoveKeysResultSchema>;

/** `GET /api/secrets/protection`. */
export const SecretsProtectionSchema = z.object({ database: DatabaseProtectionSchema, disk: DiskEncryptionSchema }).meta({ id: 'SecretsProtection' });
export type SecretsProtection = z.infer<typeof SecretsProtectionSchema>;

/** `POST /api/secrets/cli/install`: where `pi-kit-secret` went and whether that folder is on PATH. */
export const CliInstallResultSchema = z.object({ path: z.string(), dir: z.string(), onPath: z.boolean() }).meta({ id: 'CliInstallResult' });
export type CliInstallResult = z.infer<typeof CliInstallResultSchema>;

/** `POST /api/secrets/recovery-key`: the database's recovery key. It is the one secret an answer carries, once, because the person has to write it down; a second call is a 409. */
export const RecoveryKeySchema = z.object({ key: z.string() }).meta({ id: 'RecoveryKey' });
export type RecoveryKey = z.infer<typeof RecoveryKeySchema>;
