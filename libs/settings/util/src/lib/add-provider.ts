import type { Translate } from '@pi-kit/i18n';
import type { ProviderInfo, SettingsModel } from '@pi-kit/protocol';

/** Pure state machine for provider setup. Account sign-in uses the sign-in step;
 * local servers and LiteLLM connect on the address step and then show what was saved. */

export type ProviderMethod = 'radius' | 'subscription' | 'api_key' | 'local' | 'litellm';
export type AddProviderStep = 'how' | 'which' | 'sign-in' | 'done';

export interface AddProviderState {
  step: AddProviderStep;
  method?: ProviderMethod;
  /** The provider ID once chosen; local connections resolve theirs when saved. */
  provider?: string;
  /** The way the last move went: the next step slides in from the right going forward, from the left going back. */
  direction: 'forward' | 'back';
  /** The search field of "which". */
  query: string;
}

export const RADIUS = 'radius';

/** The steps a way goes through, in order. */
export function stepsOf(method: ProviderMethod | undefined): AddProviderStep[] {
  switch (method) {
    case 'radius':
      return ['how', 'sign-in', 'done'];
    case 'litellm':
    case 'local':
      return ['how', 'which', 'done'];
    default:
      return ['how', 'which', 'sign-in', 'done'];
  }
}

/** The wizard from its first step, or from a place the page sends it: "Edit" on a local server opens the address, "Add a key instead" the key's provider. */
export function startAddProvider(entry: { method?: ProviderMethod; provider?: string } = {}): AddProviderState {
  const state: AddProviderState = { step: 'how', direction: 'forward', query: '' };
  if (!entry.method) return state;
  return { ...choose(state, entry.method), ...(entry.provider ? { provider: entry.provider } : {}) };
}

/** A way is chosen: the next step follows (Radius goes straight to its sign-in). */
export function choose(state: AddProviderState, method: ProviderMethod): AddProviderState {
  const base: AddProviderState = { ...state, method, query: '', direction: 'forward' };
  if (method === 'radius') return { ...base, step: 'sign-in', provider: RADIUS };
  const { provider: _provider, ...rest } = base;
  return { ...rest, step: 'which' };
}

/** A provider is picked in "which"; the step stays. */
export function pick(state: AddProviderState, provider: string): AddProviderState {
  return { ...state, provider };
}

export function search(state: AddProviderState, query: string): AddProviderState {
  return { ...state, query };
}

/** Whether "Continue" can be pressed on the step. The sign-in and done steps have buttons of their own. */
export function canContinue(state: AddProviderState): boolean {
  switch (state.step) {
    case 'how':
      return state.method !== undefined;
    case 'which':
      return state.method === 'local' || state.method === 'litellm' ? false : !!state.provider;
    default:
      return false;
  }
}

/** The step after this one, or this one when it is the last. */
export function next(state: AddProviderState): AddProviderState {
  const steps = stepsOf(state.method);
  const at = steps.indexOf(state.step);
  return { ...state, step: steps[Math.min(at + 1, steps.length - 1)], direction: 'forward' };
}

/** The step before this one; from the first, nothing changes. */
export function back(state: AddProviderState): AddProviderState {
  const steps = stepsOf(state.method);
  const at = steps.indexOf(state.step);
  return { ...state, step: steps[Math.max(at - 1, 0)], direction: 'back' };
}

/** The dots: how many of the four are lit. Radius skips "which" and its dot is lit with the next. */
export function dotsOn(state: AddProviderState): number {
  return { how: 1, which: 2, 'sign-in': 3, done: 4 }[state.step];
}

export const ADD_PROVIDER_DOTS = 4;

/** The line in the footer: where the person is and what comes next. */
export function footHint(translate: Translate, state: AddProviderState): string {
  const steps = stepsOf(state.method);
  const at = steps.indexOf(state.step);
  const after = steps[at + 1];
  const nextText: Partial<Record<AddProviderStep, string>> = {
    which: translate('settings.addProvider.chooseTheProvider'),
    'sign-in': translate('settings.addProvider.signIn'),
    done: translate('settings.addProvider.whatWasSaved'),
  };
  const total = state.method ? steps.length : 4;
  return translate('settings.addProvider.stepOf', {
    value1: at + 1,
    value2: total,
    value3: after
      ? translate('settings.addProvider.next', {
          value1:
            state.method === 'local' && after === 'done'
              ? translate('settings.addProvider.useTheServer')
              : (nextText[after] ?? ''),
        })
      : '',
  });
}

/** Whether a provider offers the way: a subscription signs in with OAuth (Radius has its own card), a key provider takes an API key. */
export function offers(provider: ProviderInfo, method: ProviderMethod): boolean {
  switch (method) {
    case 'radius':
      return provider.id === RADIUS;
    case 'subscription':
      return !!provider.subscription && provider.methods.includes('oauth') && provider.id !== RADIUS;
    case 'api_key':
      return provider.methods.includes('api_key');
    default:
      return false;
  }
}

/** The providers "which" lists for a way, narrowed by the search field (name or id), the ones not signed in yet first. */
export function providersFor(
  providers: readonly ProviderInfo[],
  method: ProviderMethod | undefined,
  query: string,
): ProviderInfo[] {
  if (!method) return [];
  const q = query.trim().toLowerCase();
  const matching = providers.filter(
    (p) => offers(p, method) && (q === '' || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
  );
  return [...matching].sort((a, b) => Number(a.configured) - Number(b.configured) || a.name.localeCompare(b.name));
}

/** What a provider adds to the picker: the model it would use as the default for new threads (the first it lists), if there is one. */
export function defaultModelOf(provider: string, models: readonly SettingsModel[]): SettingsModel | undefined {
  return models.find((m) => m.provider === provider && m.available && !m.virtual);
}

/** The title of "which" for each way. */
export function whichTitle(translate: Translate, method: ProviderMethod | undefined): string {
  switch (method) {
    case 'subscription':
      return translate('settings.addProvider.whichSubscription');
    case 'api_key':
      return translate('settings.addProvider.whichProviderIsTheKeyFor');
    case 'litellm':
      return translate('settings.litellm.title');
    case 'local':
      return translate('settings.addProvider.whereDoesTheServerRun');
    default:
      return 'Which?';
  }
}
