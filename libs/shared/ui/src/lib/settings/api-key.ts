/**
 * Help for the API-key workflow: where a provider’s key page is, what the key needs, and whether pasted
 * text looks like that provider’s keys. Only the *shape* is ever looked at here (a prefix and a length); the text itself is not kept by any of
 * these functions and they never log it.
 */

import type { Translate } from '@pi-kit/i18n';
export interface KeyHelp {
  /** The provider’s own page for creating a key. */
  url?: string;
  /** What the key needs, in one sentence. */
  needs: string;
  /** Keys of this provider start with this. */
  prefix?: string;
  /** The least a real key has. */
  minLength: number;
}

const providerKeyHelp = (translate: Translate): Record<string, KeyHelp> => ({
  openrouter: {
    url: 'https://openrouter.ai/settings/keys',
    needs: translate('shared.apiKey.itNeedsNoSpecialScopesOpenRouterBills'),
    prefix: 'sk-or-',
    minLength: 30,
  },
  anthropic: {
    url: 'https://console.anthropic.com/settings/keys',
    needs: translate('shared.apiKey.aKeyFromTheAnthropicConsoleWith'),
    prefix: 'sk-ant-',
    minLength: 30,
  },
  openai: {
    url: 'https://platform.openai.com/api-keys',
    needs: translate('shared.apiKey.aProjectKeyWithAccessToThe'),
    prefix: 'sk-',
    minLength: 30,
  },
  google: {
    url: 'https://aistudio.google.com/apikey',
    needs: translate('shared.apiKey.aGeminiAPIKeyFromGoogleAI'),
    prefix: 'AIza',
    minLength: 30,
  },
  groq: {
    url: 'https://console.groq.com/keys',
    needs: translate('shared.apiKey.aKeyFromTheGroqConsole'),
    prefix: 'gsk_',
    minLength: 30,
  },
  xai: {
    url: 'https://console.x.ai',
    needs: translate('shared.apiKey.anAPIKeyFromTheXAIConsole'),
    prefix: 'xai-',
    minLength: 30,
  },
  deepseek: {
    url: 'https://platform.deepseek.com/api_keys',
    needs: translate('shared.apiKey.aKeyFromTheDeepSeekPlatformWith'),
    prefix: 'sk-',
    minLength: 24,
  },
  cerebras: {
    url: 'https://cloud.cerebras.ai',
    needs: translate('shared.apiKey.aKeyFromTheCerebrasCloudConsole'),
    prefix: 'csk-',
    minLength: 24,
  },
  mistral: {
    url: 'https://console.mistral.ai/api-keys',
    needs: translate('shared.apiKey.aKeyFromTheMistralConsoleWith'),
    minLength: 24,
  },
  fireworks: {
    url: 'https://fireworks.ai/account/api-keys',
    needs: translate('shared.apiKey.aKeyFromYourFireworksAccount'),
    prefix: 'fw_',
    minLength: 20,
  },
  huggingface: {
    url: 'https://huggingface.co/settings/tokens',
    needs: translate('shared.apiKey.aTokenWithPermissionToCallInference'),
    prefix: 'hf_',
    minLength: 20,
  },
});

const genericKeyHelp = (translate: Translate): KeyHelp => ({
  needs: translate('shared.apiKey.theKeyYourProviderIssuedForAPI'),
  minLength: 8,
});

export function keyHelp(translate: Translate, providerId: string): KeyHelp {
  return providerKeyHelp(translate)[providerId] ?? genericKeyHelp(translate);
}

export type KeyShape =
  | { state: 'empty'; message: string }
  | { state: 'ok'; message: string }
  /** Nothing is known about this provider’s keys, or it looks plausible but cannot be told apart. */
  | { state: 'unknown'; message: string }
  | { state: 'mismatch'; message: string };

/** Whether pasted text has the shape of this provider’s keys. Never returns, logs or keeps any part of the text. */
export function checkKeyShape(translate: Translate, providerId: string, providerName: string, text: string): KeyShape {
  if (text.length === 0)
    return {
      state: 'empty',
      message: translate('shared.apiKey.pasteTheKeyHereItGoesInto'),
    };
  if (/\s/.test(text)) return { state: 'mismatch', message: translate('shared.apiKey.theTextContainsASpaceOrA') };
  const help = providerKeyHelp(translate)[providerId];
  if (!help) {
    return text.length >= genericKeyHelp(translate).minLength
      ? {
          state: 'unknown',
          message: translate('shared.apiKey.piKitCannotTellWhatKeysLook', { value1: providerName }),
        }
      : { state: 'mismatch', message: translate('shared.apiKey.thatIsTooShortToBeA') };
  }
  if (help.prefix && !text.startsWith(help.prefix))
    return {
      state: 'mismatch',
      message: translate('shared.apiKey.keysStartWithThisOneDoesNot', { value1: providerName, value2: help.prefix }),
    };
  if (text.length < help.minLength)
    return { state: 'mismatch', message: translate('shared.apiKey.thatIsShorterThanARealKey') };
  return {
    state: 'ok',
    message: translate('shared.apiKey.looksLikeKeyItGoesIntoYour', {
      value1: /^[aeiou]/i.test(providerName) ? translate('shared.apiKey.an') : translate('shared.apiKey.a'),
      value2: providerName,
    }),
  };
}

/** The last four characters of a key, for the display of a stored one; text shorter than eight characters gives an empty string. */
export function lastFour(text: string): string {
  return text.length >= 8 ? text.slice(-4) : '';
}

/**
 * Where a credential lives, in words: the same four honest labels everywhere a credential is listed. `osLabel` is the credential store's own name
 * ("macOS Keychain"); an API key in `auth.json` says it is plain text, an OAuth token says pi refreshes it.
 */
export function credentialStoreText(
  translate: Translate,
  store: 'auth.json' | 'keychain' | 'command' | 'environment',
  type: 'api_key' | 'oauth',
  osLabel?: string,
): string {
  switch (store) {
    case 'keychain':
      return osLabel ? translate('shared.apiKey.keychain', { value1: osLabel }) : 'keychain';
    case 'command':
      return translate('shared.apiKey.aCommandThatPrintsIt');
    case 'environment':
      return translate('shared.apiKey.environmentVariable');
    default:
      return type === 'oauth'
        ? translate('shared.apiKey.authJsonRefreshedByPi')
        : translate('shared.apiKey.authJsonPlainText');
  }
}
