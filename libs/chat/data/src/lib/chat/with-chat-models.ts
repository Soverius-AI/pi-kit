import { Language } from '@pi-kit/i18n';
import { DestroyRef, computed, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type,
  withComputed,
  withMethods,
  withState,
  type SignalStoreFeatureType,
} from '@ngrx/signals';
import { sessionModels, sessionSetModel, settingsPatch, unwrap } from '@pi-kit/api';
import { pinPattern, togglePinned } from '@pi-kit/chat/util';
import type {
  Cycle,
  ModelInfo,
  ModelProvider,
  ModelRef,
  PatchModel,
  SessionStats,
  ThinkingLevel,
} from '@pi-kit/protocol';
import { initialModels, type ChatSessionState } from './chat-state';
import { withChatState } from './with-chat-state';

type Base = SignalStoreFeatureType<typeof withChatState>;

/** Owns model state, projections and serialized model mutations. Other features use its public methods. */
export function withChatModels<_>() {
  return signalStoreFeature(
    {
      state: type<Pick<ChatSessionState, 'stats'>>(),
      props: type<
        Pick<Base['props'], '_api' | '_threads' | '_agentStore' | '_policy' | '_toasts'> & {
          _internal: Pick<Base['props']['_internal'], 'threadEpoch'>;
        }
      >(),
      methods: type<Pick<Base['methods'], '_request' | '_cancelRequest'>>(),
    },
    withState(initialModels),
    withComputed((store) => {
      const model = computed(() => store.stats()?.model ?? null);
      const info = computed(() => {
        const current = model();
        return current
          ? store.modelList()?.models.find((m) => m.provider === current.provider && m.id === current.id)
          : undefined;
      });
      const levels = computed<readonly ThinkingLevel[]>(() => info()?.levels ?? ['off']);
      return {
        model,
        modelInfo: info,
        levels,
        effort: computed<ThinkingLevel>(() => store.stats()?.thinkingLevel ?? 'off'),
        canThink: computed(() => levels().some((l) => l !== 'off')),
        cycleSet: computed<ModelInfo[]>(() => {
          const list = store.modelList();
          if (!list) return [];
          const pinned = (list.pinned ?? []).flatMap((ref) =>
            list.models.filter((m) => m.provider === ref.provider && m.id === ref.id),
          );
          return pinned.length > 0 ? pinned : list.models;
        }),
        hasScope: computed(() => (store.modelList()?.pinned?.length ?? 0) > 0),
        pinned: computed<ModelRef[]>(() => store.modelList()?.pinned ?? []),
        modelProviders: computed<ModelProvider[]>(() => store.modelList()?.providers ?? []),
      };
    }),
    withMethods((store) => {
      const translate = inject(Language).t;
      const api = store._api;
      const toasts = store._toasts;
      const threadId = () => store._threads.selectedId();
      let mutationVersion = 0;
      let pendingChanges = 0;
      inject(DestroyRef).onDestroy(() => {
        mutationVersion++;
      });
      let mutations: Promise<unknown> = Promise.resolve();
      async function loadModels(id = threadId()): Promise<void> {
        if (!id) return;
        await store._request(
          'models',
          (signal) => unwrap(sessionModels({ client: api.client, signal, query: { thread: id } })),
          {
            valid: () => threadId() === id,
            next: (modelList) => patchState(store, { modelList, modelError: undefined }),
            error: (error) => patchState(store, { modelError: error instanceof Error ? error.message : String(error) }),
          },
        );
      }
      function modelToast(level: 'info' | 'warning', text: string): void {
        toasts.show(
          level,
          store._agentStore().isRunning()
            ? translate('chat.withChatModels.appliesToTheNextRequest', { value1: text })
            : text,
          store._policy.cycleToastMs,
        );
      }
      function markChanged(change: { model: boolean; effort: boolean }): void {
        if (!store._agentStore().isRunning()) return;
        const was = store.changedDuringRun();
        patchState(store, {
          changedDuringRun: { model: change.model || !!was?.model, effort: change.effort || !!was?.effort },
        });
      }
      async function patchModel(change: PatchModel): Promise<SessionStats | undefined> {
        const id = threadId();
        if (!id) return undefined;
        pendingChanges++;
        const version = ++mutationVersion;
        const epoch = store._internal.threadEpoch;
        store._cancelRequest('stats');
        const pending = mutations.then(() =>
          unwrap(sessionSetModel({ client: api.client, path: { id }, body: change })),
        );
        mutations = pending.catch(() => undefined);
        try {
          const stats = await pending;
          if (threadId() !== id || epoch !== store._internal.threadEpoch || version !== mutationVersion)
            return undefined;
          await loadModels(id);
          if (threadId() !== id || epoch !== store._internal.threadEpoch || version !== mutationVersion)
            return undefined;
          store._cancelRequest('stats');
          patchState(store, { stats, modelError: undefined });
          return stats;
        } catch (error) {
          if (threadId() === id && epoch === store._internal.threadEpoch && version === mutationVersion) {
            const message = error instanceof Error ? error.message : String(error);
            patchState(store, { modelError: message });
            toasts.show('error', message);
          }
          return undefined;
        } finally {
          pendingChanges--;
        }
      }
      const isCurrentModel = (model: Pick<ModelInfo, 'provider' | 'id'>): boolean => {
        const current = store.model();
        return current?.provider === model.provider && current.id === model.id;
      };
      return {
        loadModels,
        isCurrentModel,
        _modelToast: modelToast,
        _clearModelChange: (): void => patchState(store, { changedDuringRun: undefined }),
        _resetModels(): void {
          mutationVersion++;
          store._cancelRequest('models');
          patchState(store, initialModels);
        },
        /** ⌘⇧M: the next (or previous) model of the scope. */
        async cycleModel(direction: 'forward' | 'backward' = 'forward'): Promise<void> {
          const before = store.model();
          const beforeEffort = store.effort();
          const after = await patchModel({ cycle: { target: 'model', direction } satisfies Cycle });
          if (!after) return;
          if (after.model?.provider === before?.provider && after.model?.id === before?.id) {
            return modelToast(
              'info',
              store.cycleSet().length > 1
                ? translate('chat.withChatModels.modelUnchanged')
                : translate('chat.withChatModels.onlyOneModelToCyclePinMore'),
            );
          }
          markChanged({ model: true, effort: after.thinkingLevel !== beforeEffort });
          modelToast(
            'info',
            translate('chat.withChatModels.modelEffort', {
              value1: after.model?.id ?? translate('chat.withChatModels.noModel'),
              value2: translate('common.effortValue.' + after.thinkingLevel),
            }),
          );
        },
        /** ⌘⇧E: the next effort level the current model accepts. */
        async cycleEffort(): Promise<void> {
          if (!store.canThink())
            return modelToast(
              'info',
              translate('chat.withChatModels.hasNoEffortLevels', {
                value1: store.model()?.id ?? translate('chat.withChatModels.thisModel'),
              }),
            );
          const after = await patchModel({ cycle: { target: 'thinking' } satisfies Cycle });
          if (!after) return;
          markChanged({ model: false, effort: true });
          modelToast(
            'info',
            translate('chat.withChatModels.effort', { value1: translate('common.effortValue.' + after.thinkingLevel) }),
          );
        },
        async chooseModel(model: Pick<ModelInfo, 'provider' | 'id'>): Promise<boolean> {
          if (pendingChanges === 0 && isCurrentModel(model)) return true;
          const beforeEffort = store.effort();
          const after = await patchModel({ provider: model.provider, modelId: model.id });
          if (after) markChanged({ model: true, effort: after.thinkingLevel !== beforeEffort });
          return !!after;
        },
        /** The pin on a row of the picker: the model joins the pinned set or leaves it, without Settings. Resolves to whether pi took the change. */
        async togglePinnedModel(model: Pick<ModelInfo, 'provider' | 'id'>): Promise<boolean> {
          try {
            await unwrap(
              settingsPatch({
                client: api.client,
                query: {},
                body: {
                  enabledModels:
                    togglePinned(store.pinned(), model).map(pinPattern) &&
                    togglePinned(store.pinned(), model).map(pinPattern).length > 0
                      ? togglePinned(store.pinned(), model).map(pinPattern)
                      : null,
                },
              }),
            );
            await loadModels();
            return true;
          } catch (error) {
            toasts.show('error', error instanceof Error ? error.message : String(error));
            return false;
          }
        },
        async setEffort(level: ThinkingLevel): Promise<boolean> {
          if (pendingChanges === 0 && level === store.effort()) return true;
          const after = await patchModel({ thinkingLevel: level });
          if (after) markChanged({ model: false, effort: true });
          return !!after;
        },
      };
    }),
  );
}
