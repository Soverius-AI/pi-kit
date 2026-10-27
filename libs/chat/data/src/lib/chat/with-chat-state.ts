import { Injector, inject } from '@angular/core';
import { CopilotKit, injectAgentStore, injectInterrupt } from '@copilotkit/angular';
import { signalStoreFeature, withProps, withState } from '@ngrx/signals';
import { ApiClient, BackendService } from '@pi-kit/api';
import {
  CONTEXT_POLICY,
  HealthStore,
  RedactionStore,
  ToastStore,
  UiStore,
  withLatestRequest,
  withRequestStatus,
} from '@pi-kit/data-access';
import { ThreadsStore } from '@pi-kit/threads/api';
import { CHAT_AGENT, CHAT_POLICY } from '../chat-policy';
import { ComposerExtensions } from '../composer-extensions';
import { type ChatSessionState, initial } from './chat-state';
import { ThreadReplayCacheStore } from '../thread-replay-cache.store';

/** Backing state and injected collaborators shared by the chat features. */
export function withChatState() {
  return signalStoreFeature(
    withState<ChatSessionState>(initial),
    withRequestStatus(),
    withLatestRequest(),
    withProps(() => ({
      _policy: inject(CHAT_POLICY),
      _agent: inject(CHAT_AGENT),
      _replayCache: inject(ThreadReplayCacheStore),
      _contextPolicy: inject(CONTEXT_POLICY),
      _copilotKit: inject(CopilotKit),
      _threads: inject(ThreadsStore),
      _api: inject(ApiClient),
      _backend: inject(BackendService),
      _health: inject(HealthStore),
      _bus: inject(UiStore),
      _toasts: inject(ToastStore),
      /** The redaction pass for what is drawn. */
      _redaction: inject(RedactionStore),
      _extensions: inject(ComposerExtensions),
      /** Looked up when needed: the command registry and the graph state use this store themselves. */
      _injector: inject(Injector),
      /** The AG-UI agent this store follows (`pi`, or `pi-bg` for an agent's transcript); its `threadId` follows the selected thread. */
      _agentStore: injectAgentStore(inject(CHAT_AGENT).agentId),
      /** Extension dialogs (`pi.ui.*` interrupts): `interrupts()` lists them, `resolve` / `cancel` resume the run. */
      interrupt: injectInterrupt<unknown, never>({ agentId: inject(CHAT_AGENT).agentId }),
      /** Counters and callbacks that are not state. */
      _internal: {
        threadEpoch: 0,
        /** Selection changes invalidate submissions; replaying the same thread for a branch does not. */
        selectionEpoch: 0,
        selectionThreadId: undefined as string | undefined,
        noticeId: 0,
        caretN: 0,
        draftVersion: 0,
        connectWaiters: [] as (() => void)[],
        connectRetries: 0,
        /** The status channel announced a run while a replay was going: joined once the replay is over. */
        rejoinWanted: false,
        /** The status channel announced a run while another was going here: joined once that one is over, unless it was that one. */
        pendingRun: undefined as string | undefined,
        /** The runs this transcript saw start, own or joined: the channel's "running" for one of them is no news. */
        seenRuns: new Set<string>(),
        retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      },
    })),
  );
}
