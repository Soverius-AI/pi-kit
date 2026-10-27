import type { Translate } from '@pi-kit/i18n';
import { groupProviders, type ProviderInfo, type SettingsModel } from '@pi-kit/protocol';
import { credentialStoreText } from '@pi-kit/ui';

/**
 * What Settings › Providers lists, computed from pi's overview with no Angular: which providers are rows, what each row says in its chip and
 * its credential line, which icon actions it has, and the read-only group of keys found in the environment. A provider that is not signed in is not a row; it is one
 * of the choices of the "+" wizard.
 */

/** How a provider is signed in, which is what the state chip says. */
export type ProviderKind = 'subscription' | 'api_key' | 'local' | 'gateway' | 'environment' | 'other';

/** The icon actions of a row (each has a tooltip and an `aria-label`); `add-key` is the one text button of an environment row. */
export type ProviderAction = 'sign-out' | 'change-key' | 'remove-key' | 'test' | 'edit' | 'add-key' | 'remove-provider';

export interface ProviderRow {
  id: string;
  name: string;
  /** The tile's letters. */
  letters: string;
  kind: ProviderKind;
  chip: { text: string; tone: 'ok' | 'off' | 'warn' };
  models: number;
  /** "key ending in a1b2 · macOS Keychain · added today". Never the key. */
  line: string;
  actions: ProviderAction[];
  /** What the provider reports about its usage; the row shows a bar per window. */
  usage?: NonNullable<ProviderInfo['usage']>;
}

/** The tile letters: the initials of a two-word name, else its first two characters. "OpenRouter" is "Op", "GitHub Copilot" is "GC". */
export function letters(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_/.]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** “today”, “yesterday”, “3 days ago”, or a date after a month. */
export function agoText(translate: Translate, at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return translate('settings.providers.daysAgo', { value1: days });
  return new Date(at).toLocaleDateString(translate('common.locale'), {
    month: 'short',
    day: 'numeric',
    ...(days > 300 ? { year: 'numeric' } : {}),
  });
}

/** Where a provider's credential comes from, which decides the group it is listed in. */
export function providerKind(provider: ProviderInfo): ProviderKind {
  if (provider.id === 'litellm') return 'gateway';
  if (provider.credential?.type === 'oauth' || (provider.stored && provider.storedType === 'oauth'))
    return 'subscription';
  if (provider.credential?.type === 'api_key' || (provider.stored && provider.storedType === 'api_key'))
    return 'api_key';
  if (provider.configured && provider.source === 'environment') return 'environment';
  if (provider.configured && provider.source?.startsWith('models_json')) return 'local';
  return 'other';
}

const providerChips = (translate: Translate): Record<ProviderKind, ProviderRow['chip']> => ({
  subscription: { text: translate('settings.providers.subscription'), tone: 'ok' },
  api_key: { text: translate('settings.providers.aPIKey'), tone: 'ok' },
  gateway: { text: translate('settings.litellm.gateway'), tone: 'ok' },
  local: { text: translate('settings.providers.local'), tone: 'ok' },
  environment: { text: translate('settings.providers.environment'), tone: 'off' },
  other: { text: translate('settings.providers.configured'), tone: 'ok' },
});

const ACTIONS: Record<ProviderKind, ProviderAction[]> = {
  subscription: ['sign-out'],
  api_key: ['change-key', 'remove-key'],
  local: ['test', 'edit', 'remove-provider'],
  gateway: ['edit', 'remove-provider'],
  environment: ['add-key'],
  other: [],
};

/** The line under a row's name; the store is named honestly: keychain, auth.json in plain text, a command, an environment variable. */
export function credentialLine(
  translate: Translate,
  provider: ProviderInfo,
  osLabel: string | undefined,
  address?: string,
  now = Date.now(),
): string {
  if (provider.id === 'litellm') return translate('settings.litellm.connectionLine');
  const credential = provider.credential;
  if (credential?.type === 'api_key') {
    const when = credential.addedAt
      ? translate('settings.providers.added', { value1: agoText(translate, credential.addedAt, now) })
      : translate('settings.providers.addedOutsidePiKit');
    const where = credentialStoreText(translate, credential.store, 'api_key', osLabel);
    return credential.lastFour
      ? translate('settings.providers.keyEndingIn', { value1: credential.lastFour, value2: where, value3: when })
      : translate('settings.providers.keyFrom', { value1: where, value2: when });
  }
  if (credential?.type === 'oauth')
    return translate('settings.providers.signedInWithASubscription', {
      value1: credential.addedAt
        ? translate('settings.providers.signedIn', { value1: agoText(translate, credential.addedAt, now) })
        : '',
      value2: credentialStoreText(translate, 'auth.json', 'oauth'),
    });
  if (provider.source === 'environment')
    return translate('settings.providers.fromInTheShellPiKitStarted', {
      value1: provider.label ?? translate('settings.providers.anEnvironmentVariable'),
    });
  if (provider.source?.startsWith('models_json'))
    return address
      ? translate('settings.providers.piSModelsJson', { value1: address })
      : translate('settings.providers.aServerSetUpInPiS');
  if (provider.source === 'runtime') return translate('settings.providers.configuredForThisRun');
  return translate('settings.providers.configured668c5');
}

/** The providers that are signed in (a stored credential, a models.json server, a runtime key), one row each. Environment keys are not here: see {@link environmentRows}. */
export function providerRows(
  translate: Translate,
  providers: readonly ProviderInfo[],
  models: readonly SettingsModel[],
  osLabel?: string,
  addresses: Readonly<Record<string, string>> = {},
  now = Date.now(),
): ProviderRow[] {
  return providers
    .filter((p) => (p.configured || p.stored) && providerKind(p) !== 'environment')
    .map((p) => row(translate, p, models, osLabel, addresses, now));
}

/** The keys pi found in the environment and nothing stored beside them: a read-only group with "Add a key instead". */
export function environmentRows(
  translate: Translate,
  providers: readonly ProviderInfo[],
  models: readonly SettingsModel[],
  osLabel?: string,
  now = Date.now(),
): ProviderRow[] {
  return providers
    .filter((p) => !p.stored && p.configured && providerKind(p) === 'environment')
    .map((p) => row(translate, p, models, osLabel, {}, now));
}

function row(
  translate: Translate,
  provider: ProviderInfo,
  models: readonly SettingsModel[],
  osLabel: string | undefined,
  addresses: Readonly<Record<string, string>>,
  now: number,
): ProviderRow {
  const kind = providerKind(provider);
  const chip =
    kind === 'environment'
      ? { text: provider.label ?? 'environment', tone: 'off' as const }
      : providerChips(translate)[kind];
  // An API-key provider that can also sign in as a subscription keeps its API-key actions only when the credential is a key.
  const actions = ACTIONS[kind].filter((a) => a !== 'change-key' || provider.methods.includes('api_key'));
  // A custom endpoint can also have a stored credential; removing only its key leaves the connection behind.
  if (provider.source?.startsWith('models_json') && !actions.includes('remove-provider'))
    actions.push('remove-provider');
  return {
    id: provider.id,
    name: provider.name,
    letters: letters(provider.name),
    kind,
    chip,
    models: models.filter((m) => m.provider === provider.id).length,
    line: credentialLine(translate, provider, osLabel, addresses[provider.id], now),
    actions,
    ...(provider.usage ? { usage: provider.usage } : {}),
  };
}

/** "17 models", "1 model"; nothing for none. */
export function modelCountText(count: number): string {
  return count === 0 ? '' : `${count} ${count === 1 ? 'model' : 'models'}`;
}

/** The count in the nav: how many providers are signed in. */
export function signedInCount(providers: readonly ProviderInfo[]): number {
  return groupProviders(providers.filter((p) => p.configured)).length;
}
