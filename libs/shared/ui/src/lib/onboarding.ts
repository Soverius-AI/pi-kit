import type { Translate } from '@pi-kit/i18n';
import type { LocalServer, ProviderInfo, SettingsModel, SetupInfo } from '@pi-kit/protocol';
import { compactNumber } from './thinking';

/** The pure half of the first-run onboarding: the steps, when it opens, what the Welcome card found, what each model card says about itself. */

export type OnboardingStepId = 'welcome' | 'model' | 'defaults' | 'folder' | 'prompt';

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  /** The line under the title in the rail. */
  sub: string;
}

export const onboardingSteps = (translate: Translate): readonly OnboardingStep[] => [
  { id: 'welcome', title: translate('shared.onboarding.welcome'), sub: translate('shared.onboarding.whatPiKitFound') },
  { id: 'model', title: translate('shared.onboarding.getAModel'), sub: translate('shared.onboarding.signInOrAddAKey') },
  {
    id: 'defaults',
    title: translate('shared.onboarding.defaults'),
    sub: translate('shared.onboarding.modelEffortCompaction'),
  },
  {
    id: 'folder',
    title: translate('shared.onboarding.openAFolder'),
    sub: translate('shared.onboarding.wherePiMayWork'),
  },
  { id: 'prompt', title: translate('shared.onboarding.firstPrompt'), sub: translate('shared.onboarding.seeItAnswer') },
];

export const stepIndex = (translate: Translate, id: OnboardingStepId): number =>
  onboardingSteps(translate).findIndex((s) => s.id === id);

/**
 * Whether the flow opens by itself at launch. A person who never finished or skipped it sees it once (an existing pi user gets the Welcome card with the
 * fast path); after that it opens again only when no provider has a model, and not when it was skipped. `PI_KIT_SKIP_ONBOARDING` (the tests) switches it off.
 */
export function shouldAutoOpen(info: Pick<SetupInfo, 'autoOpenOff' | 'needsSetup' | 'onboarding'>): boolean {
  if (info.autoOpenOff) return false;
  if (!info.onboarding) return true;
  return info.needsSetup && info.onboarding.state !== 'skipped';
}

/** `:8080` from a base URL. */
const portOf = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl);
    return url.port ? `:${url.port}` : url.host;
  } catch {
    return baseUrl;
  }
};

const plural = (translate: Translate, n: number, noun: string): string =>
  translate(`common.counts.${noun}.${n === 1 ? 'one' : 'other'}`, { count: n });

/** The pieces of the "Found:" box , as short phrases, in this order: pi, the command line, the agent folder, local servers. */
export function foundLines(
  translate: Translate,
  info: SetupInfo,
): { text: string; strong: string; tone?: 'ok' | 'muted' }[] {
  const lines: { text: string; strong: string; tone?: 'ok' | 'muted' }[] = [];
  lines.push({
    strong: `pi ${info.pi.version}`,
    text:
      info.pi.source === 'bundled'
        ? 'bundled'
        : info.pi.source === 'managed'
          ? translate('shared.onboarding.fromPiSOwnInstall')
          : translate('shared.onboarding.fromPIKITPIDIR'),
  });
  if (info.pathPi.found)
    lines.push({
      strong: info.pathPi.version ? `pi ${info.pathPi.version}` : 'pi',
      text: translate('shared.onboarding.onPATH'),
    });
  const agent = info.agentDir;
  if (!agent.exists)
    lines.push({
      strong: agent.path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~'),
      text: translate('shared.onboarding.doesNotExistYet'),
      tone: 'muted',
    });
  else {
    const parts = [
      agent.auth.length > 0 ? plural(translate, agent.auth.length, 'credential') : '',
      agent.hasModelsJson ? 'models.json' : '',
      agent.sessionCount > 0 ? plural(translate, agent.sessionCount, 'session') : '',
    ].filter(Boolean);
    lines.push({
      strong: agent.path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~'),
      text: parts.length > 0 ? parts.join(', ') : translate('shared.onboarding.isEmpty'),
      tone: parts.length > 0 ? 'ok' : 'muted',
    });
  }
  for (const server of info.localServers)
    lines.push({
      strong:
        server.kind === 'ollama'
          ? 'Ollama'
          : server.kind === 'llama-swap'
            ? 'llama-swap'
            : translate('shared.onboarding.aLocalServer'),
      text: translate('shared.onboarding.onad955', {
        value1: portOf(server.baseUrl),
        value2: plural(translate, server.models.length, 'model'),
      }),
      tone: 'ok',
    });
  return lines;
}

/** The label of a model in a select: name, provider, context, price. */
export function modelOptionLabel(translate: Translate, model: SettingsModel): string {
  const price =
    (model.costInput ?? 0) === 0 && (model.costOutput ?? 0) === 0
      ? 'free'
      : translate('shared.onboarding.per1M', { value1: model.costInput ?? 0, value2: model.costOutput ?? 0 });
  return `${model.name} · ${model.provider} · ${model.contextWindow ? translate('shared.onboarding.context', { value1: compactNumber(model.contextWindow) }) : ''}${price}`;
}

export const RADIUS = 'radius';

/** Where a provider shows up among the four cards. */
export type CardKind = 'radius' | 'subscription' | 'key' | 'local';

/** A stored credential line for the cards: `OpenRouter key …a1b2 · keychain`, `Claude signed in`. */
export function credentialStatus(translate: Translate, provider: ProviderInfo, modelCount: number): string {
  const models = modelCount > 0 ? `, ${plural(translate, modelCount, 'model')}` : '';
  const credential = provider.credential;
  if (credential?.type === 'oauth')
    return translate('shared.onboarding.signedIn', { value1: provider.name, value2: models });
  if (credential?.type === 'api_key') {
    const key = translate('shared.onboarding.key', {
      value1: provider.name,
      value2: credential.lastFour ? ` …${credential.lastFour}` : '',
    });
    if (credential.store === 'keychain')
      return translate('shared.onboarding.keptInTheKeychain', { value1: key, value2: models });
    if (credential.store === 'command')
      return translate('shared.onboarding.keyFromACommand', { value1: provider.name, value2: models });
    if (credential.store === 'environment')
      return translate('shared.onboarding.keyFromAnEnvironmentVariable', { value1: provider.name, value2: models });
    return translate('shared.onboarding.savedInAuthJsonPlainText', { value1: key, value2: models });
  }
  return translate('shared.onboarding.configured', { value1: provider.name, value2: models });
}

/** The cards' summary of what is already usable: the subscription providers signed in, the keys saved, the local providers. */
export function cardStatuses(
  translate: Translate,
  providers: readonly ProviderInfo[],
  models: readonly SettingsModel[],
): Record<CardKind, string[]> {
  const count = (id: string): number => models.filter((m) => m.provider === id).length;
  const out: Record<CardKind, string[]> = { radius: [], subscription: [], key: [], local: [] };
  for (const provider of providers) {
    if (!provider.configured) continue;
    if (provider.id === RADIUS) out.radius.push(credentialStatus(translate, provider, count(provider.id)));
    else if (provider.source?.startsWith('models_json') && !provider.stored)
      out.local.push(
        translate('shared.onboarding.configuredInModelsJson', {
          value1: provider.name,
          value2: plural(translate, count(provider.id), 'model'),
        }),
      );
    else if (provider.credential?.type === 'oauth' && provider.subscription)
      out.subscription.push(credentialStatus(translate, provider, count(provider.id)));
    else if (provider.credential?.type === 'api_key' || provider.credential?.type === 'oauth')
      out.key.push(credentialStatus(translate, provider, count(provider.id)));
    else if (provider.source === 'environment')
      out.key.push(
        translate('shared.onboarding.through', {
          value1: provider.name,
          value2: provider.label ?? translate('shared.onboarding.anEnvironmentVariable'),
          value3: plural(translate, count(provider.id), 'model'),
        }),
      );
  }
  return out;
}

/** Three first prompts that suit what the person opened: an empty scratch folder, or a real project. */
export function suggestedPrompts(translate: Translate, scratch: boolean): string[] {
  return scratch
    ? [
        translate('shared.onboarding.writeASmallScriptThatPrintsThe'),
        translate('shared.onboarding.whatToolsDoYouHaveHereAnswer'),
        translate('shared.onboarding.createAREADMEMdThatExplainsWhat'),
      ]
    : [
        translate('shared.onboarding.explainWhatThisProjectDoesAndHow'),
        translate('shared.onboarding.findTheThreeMostComplexFilesAnd'),
        translate('shared.onboarding.suggestOneSmallImprovementAndShowIt'),
      ];
}

/** `llama-swap on :8080` for a server row. */
export function serverLabel(translate: Translate, server: LocalServer): string {
  return translate('shared.onboarding.on', {
    value1:
      server.kind === 'ollama'
        ? 'Ollama'
        : server.kind === 'llama-swap'
          ? 'llama-swap'
          : translate('shared.onboarding.localServer'),
    value2: portOf(server.baseUrl),
  });
}

/**
 * Whether a run's error text says the provider refused the credential (HTTP 401): the window then offers "Sign in again". A 403 is not here: it
 * usually means a plan or a quota, which a new sign-in does not fix.
 */
export function isCredentialRejection(message: string): boolean {
  return /\b401\b|unauthori[sz]ed|invalid[_ ](api[_ ]?)?key|incorrect api key|authentication (failed|error)|invalid[_ ]x-api-key|token (has )?expired|oauth token/i.test(
    message,
  );
}

/** Where a Radius account adds funds. */
export const RADIUS_FUNDS_URL = 'https://radius.pi.dev';

/** Whether a run's error text says the gateway account has no balance left (HTTP 402): the window then offers "Add funds". */
export function isOutOfFunds(message: string): boolean {
  return /\b402\b|payment required|insufficient[_ ](balance|funds|credits?)/i.test(message);
}
