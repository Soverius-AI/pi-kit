import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, setupReady, setupScratch, setupState, unwrap } from '@pi-kit/api';
import { ToastStore, UiStore } from '@pi-kit/data-access';
import type { ReadyResult } from '@pi-kit/protocol';
import { ProviderCardsStore, SettingsStore } from '@pi-kit/settings/api';
import { ThreadsStore } from '@pi-kit/threads/api';
import {
  EFFORT_LEVELS,
  onboardingSteps,
  type OnboardingStepId,
  modelOptionLabel,
  stepIndex,
  suggestedPrompts,
} from '@pi-kit/ui';

export type ReadyState =
  { phase: 'idle' } | { phase: 'checking'; model: string } | { phase: 'done'; result: ReadyResult };

interface OnboardingState {
  step: OnboardingStepId;
  /** The folder card. */
  folderPath: string;
  folder: { phase: 'idle' | 'opening'; opened?: string; scratch: boolean; error?: string };
  /** The "pi is ready" check of the last card, and the thread the first prompt goes to. */
  ready: ReadyState;
  firstThread: string | undefined;
}

/**
 * First-run onboarding. The flow is one card at a time with a progress rail: Welcome (what was found, "Use my existing
 * pi setup"), Get a model (Radius, a subscription, an API key, a local model: the cards of `pk-get-model`), Pick defaults, Open a folder, First prompt. It opens
 * by itself on a first run or when no provider has a model (`shouldAutoOpen`), and with `/setup`; every step can be skipped. Signing in, the API-key workflow, pi's
 * settings and the provider overview are `SettingsStore` (the same calls as Settings › Providers); this store keeps what is only the flow's: the step, the folder,
 * the readiness check. What detection found, the subscription picker and the local-server card are `ProviderCardsStore` (the `settings` domain: Settings › Providers
 * shows the same cards), which this store passes through so the flow's components read one store. The last step is not a card: the flow docks into a strip above the
 * real chat page, so the first prompt is typed into the real composer.
 */
export const OnboardingStore = signalStore(
  { providedIn: 'root' },
  withState<OnboardingState>({
    step: 'welcome',
    folderPath: '',
    folder: { phase: 'idle', scratch: false },
    ready: { phase: 'idle' },
    firstThread: undefined,
  }),
  withComputed((store) => {
    const translate = inject(Language).t;
    const settings = inject(SettingsStore);
    const cards = inject(ProviderCardsStore);
    const ui = inject(UiStore);
    const models = computed(() => settings.overview()?.models ?? []);
    const current = computed(() => stepIndex(translate, store.step()));
    return {
      /** The flow is showing (the full-window cards, or at the last step the strip above the real chat page); `UiStore` is the switch, the first-run check and `/setup` flip it. */
      open: computed(() => ui.onboarding()),
      steps: computed(() =>
        onboardingSteps(translate).map((s, i) => ({
          ...s,
          state: i < current() ? ('done' as const) : i === current() ? ('now' as const) : ('todo' as const),
        })),
      ),
      stepNumber: computed(() => current() + 1),
      /** The last step is shown as a strip over the real chat page, not as a card. */
      docked: computed(() => ui.onboarding() && store.step() === 'prompt'),
      providers: cards.providers,
      models,
      /** A model can be used right now: the cards' work is done. */
      hasModel: computed(() => models().length > 0),
      // The provider cards' state (`ProviderCardsStore`).
      info: cards.info,
      detecting: cards.detecting,
      detectError: cards.detectError,
      subscription: cards.subscription,
      localUrl: cards.localUrl,
      localOpen: cards.localOpen,
      local: cards.local,
      statuses: cards.statuses,
      subscriptions: cards.subscriptions,
      radius: cards.radius,
      servers: cards.servers,
      defaults: computed(() => {
        const s = settings.settings();
        const list = models();
        const selected = list.find((m) => m.provider === s?.defaultProvider && m.id === s?.defaultModel);
        return {
          options: list.map((m) => ({ value: `${m.provider}/${m.id}`, label: modelOptionLabel(translate, m) })),
          selected: selected ? `${selected.provider}/${selected.id}` : '',
          reasoning: selected?.reasoning ?? false,
          effort: s?.defaultThinkingLevel ?? 'off',
          levels: selected?.reasoning ? [...EFFORT_LEVELS] : ['off'],
          pinned: s?.enabledModels ?? [],
          autoCompaction: s?.autoCompaction ?? true,
        };
      }),
      prompts: computed(() => suggestedPrompts(translate, store.folder().scratch)),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const settings = inject(SettingsStore);
    const cards = inject(ProviderCardsStore);
    const threads = inject(ThreadsStore);
    const ui = inject(UiStore);
    const toasts = inject(ToastStore);

    const patchFolder = (patch: Partial<OnboardingState['folder']>): void =>
      patchState(store, (s) => ({ folder: { ...s.folder, ...patch } }));

    const methods = {
      /** Looks at the machine again: detection, and pi's own overview for the cards. */
      detect: (): Promise<void> => cards.detect(),

      /** The flow opened (`UiStore.onboarding` turned true): from its first card, with fresh facts. */
      async begin(): Promise<void> {
        patchState(store, {
          step: 'welcome',
          folder: { phase: 'idle', scratch: false },
          firstThread: undefined,
          ready: { phase: 'idle' },
        });
        await Promise.all([methods.detect(), settings.load()]);
        if (store.subscription() === '' && store.subscriptions().length > 0)
          cards.setSubscription(store.subscriptions()[0].id);
      },

      go(step: OnboardingStepId): void {
        patchState(store, { step });
        if (step === 'defaults') void methods.prepareDefaults();
        if (step === 'prompt') void methods.enterPrompt();
      },
      next(): void {
        const at = stepIndex(translate, store.step());
        if (at < onboardingSteps(translate).length - 1) methods.go(onboardingSteps(translate)[at + 1].id);
      },
      back(): void {
        const at = stepIndex(translate, store.step());
        if (at > 0) patchState(store, { step: onboardingSteps(translate)[at - 1].id });
      },

      async skip(): Promise<void> {
        ui.closeOnboarding();
        await unwrap(setupState({ client: api.client, body: { state: 'skipped' } })).catch(() => undefined);
      },
      async finish(): Promise<void> {
        ui.closeOnboarding();
        patchState(store, { step: 'welcome' });
        await unwrap(setupState({ client: api.client, body: { state: 'completed' } })).catch(() => undefined);
      },
      /** "Use my existing pi setup": the model step is done, so the flow goes on with the defaults, the folder and the first prompt; Skip ends it. */
      useExisting(): void {
        methods.go('defaults');
      },

      // ---- Get a model

      // The cards' own logic is `ProviderCardsStore`.
      setSubscription: (id: string): void => cards.setSubscription(id),
      signInRadius: (): Promise<void> => cards.signInRadius(),
      signInSubscription: (): Promise<void> => cards.signInSubscription(),
      addKey: (): void => cards.addKey(),
      setLocalUrl: (url: string): void => cards.setLocalUrl(url),
      toggleLocal: (): void => cards.toggleLocal(),
      testLocal: (): Promise<void> => cards.testLocal(),
      saveLocal: (baseUrl: string, models?: string[]): Promise<void> => cards.saveLocal(baseUrl, models),

      // ---- Pick defaults

      /** Entering the card: when pi has no usable default, the first model of what was just added becomes it, so the page never shows an empty choice. The overview is the one the cards just loaded. */
      async prepareDefaults(): Promise<void> {
        const first = store.models().find((m) => m.provider !== 'pi');
        if (!store.defaults().selected && first)
          await settings.patch({ defaultModel: { provider: first.provider, modelId: first.id } });
      },
      chooseModel(value: string): Promise<void> {
        const [provider, ...rest] = value.split('/');
        return settings.patch({ defaultModel: { provider, modelId: rest.join('/') } });
      },
      chooseEffort(level: string): Promise<void> {
        return settings.patch({ defaultThinkingLevel: level });
      },
      /** The pinned models ⌘⇧M cycles; none checked puts every model in the cycle. */
      togglePinned(value: string, on: boolean): Promise<void> {
        const now = store.defaults().pinned;
        return settings.setScope(on ? [...now.filter((p) => p !== value), value] : now.filter((p) => p !== value));
      },
      setCompaction(on: boolean): Promise<void> {
        return settings.patch({ autoCompaction: on });
      },

      // ---- Open a folder

      setFolderPath(path: string): void {
        patchState(store, { folderPath: path });
      },
      /** The native picker (the desktop app); a browser types the path instead. */
      async chooseFolder(): Promise<void> {
        const picked = await window.piKit?.showOpenDialog?.();
        if (picked) {
          patchState(store, { folderPath: picked });
          await methods.openFolder();
        }
      },
      async openFolder(): Promise<void> {
        const path = store.folderPath().trim();
        if (!path) return;
        patchFolder({ phase: 'opening', error: undefined });
        try {
          await threads.openWorkspace(path);
          patchFolder({ phase: 'idle', opened: path, scratch: false });
        } catch (error) {
          patchFolder({ phase: 'idle', error: errorMessage(error) });
        }
      },
      /** "Start with a scratch folder": an empty folder in pi-kit's data folder, nothing of the person's. */
      async useScratch(): Promise<void> {
        patchFolder({ phase: 'opening', error: undefined });
        try {
          const { path } = await unwrap(setupScratch({ client: api.client }));
          await threads.openWorkspace(path);
          patchState(store, { folderPath: path });
          patchFolder({ phase: 'idle', opened: path, scratch: true });
        } catch (error) {
          patchFolder({ phase: 'idle', error: errorMessage(error) });
        }
      },

      // ---- First prompt

      /** Opens a thread in the folder (the real chat page shows it) and asks pi once whether the model answers. */
      async enterPrompt(): Promise<void> {
        const cwd = store.folder().opened;
        try {
          if (cwd && !store.firstThread()) {
            const thread = await threads.create(cwd);
            if (thread) {
              patchState(store, { firstThread: thread.id });
              threads.select(thread.id);
            }
          } else if (store.firstThread()) threads.select(store.firstThread());
        } catch (error) {
          toasts.show(
            'error',
            translate('onboarding.onboardingStore.couldNotOpenAThread', { value1: errorMessage(error) }),
          );
        }
        await methods.checkReady();
      },
      /** "pi is ready": one cheap request through the default model. */
      async checkReady(): Promise<void> {
        const d = store.defaults();
        const [provider, ...rest] = d.selected.split('/');
        if (!d.selected)
          return patchState(store, {
            ready: {
              phase: 'done',
              result: {
                ok: false,
                model: '',
                message: translate('onboarding.onboardingStore.noDefaultModelIsChosenYet'),
                ms: 0,
              },
            },
          });
        patchState(store, { ready: { phase: 'checking', model: d.selected } });
        try {
          patchState(store, {
            ready: {
              phase: 'done',
              result: await unwrap(setupReady({ client: api.client, body: { provider, modelId: rest.join('/') } })),
            },
          });
        } catch (error) {
          patchState(store, {
            ready: { phase: 'done', result: { ok: false, model: d.selected, message: errorMessage(error), ms: 0 } },
          });
        }
      },
      /** A suggested prompt goes into the real composer; the person sends it. */
      usePrompt(text: string): void {
        ui.setComposerText(text);
        ui.focusComposer();
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const ui = inject(UiStore);
      let wasOpen = false;
      // The flow starts from its first card each time it opens (also when this store was only created because it opened).
      effect(() => {
        const open = ui.onboarding();
        untracked(() => {
          if (open && !wasOpen) void store.begin();
          wasOpen = open;
        });
      });
    },
  }),
);
export type OnboardingStore = InstanceType<typeof OnboardingStore>;
