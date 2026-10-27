import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideCopilotKit, ɵCOPILOTKIT_INSPECTOR_DEVELOPMENT_MODE } from '@copilotkit/angular';
import { provideMCPApps } from '@copilotkit/angular/mcp-apps';
import { BACKEND_CONNECTION, type BackendConnection } from '@pi-kit/api';
import {
  ChatConnectors,
  ChatTree,
  EMPTY_THREAD_PAGE,
  NEW_THREAD_COMPOSER,
  ThreadReplayAgent,
  TRANSCRIPT_VIEW,
  AGENT_INPUT_VIEW,
} from '@pi-kit/chat/api';
import { Transcript } from '@pi-kit/chat/feature-chat';
import { AgentInputContainer } from '@pi-kit/chat/feature-composer';
import { piKitA2uiCatalog, PkA2uiLoading, provideOpenUiSandbox } from '@pi-kit/chat/feature-genui';
import { COPILOT_INSPECTOR_AT_START, readInspectorPreference, readStorage, ViewPrefs } from '@pi-kit/data-access';
import { PK_THINKING_OPEN } from '@pi-kit/design-system';
import { ChangesStore } from '@pi-kit/review/api';
import { GraphStore } from '@pi-kit/session-tree/api';
import { ConnectorsStore } from '@pi-kit/settings/api';
import { ThreadShell, WorktreeReview } from '@pi-kit/threads/api';
import { provideLanguage, readLanguagePreference } from '@pi-kit/i18n';
import { ShellStore } from './shell.store';

export interface BackendEndpoint {
  /** e.g. `http://127.0.0.1:4300`; no trailing slash. */
  url: string;
  /** Per-launch bearer token; empty when it could not be obtained. */
  token: string;
}

/** The runtime mounted by the backend; the renderer never talks to pi directly. */
export const RUNTIME_PATH = '/api/copilotkit';

export function buildAppConfig(
  backend: BackendEndpoint,
  connection?: BackendConnection,
  inspector = readInspectorPreference(),
): ApplicationConfig {
  return {
    providers: [
      provideLanguage(() => readLanguagePreference(readStorage('pi-kit.look'))),
      { provide: COPILOT_INSPECTOR_AT_START, useValue: inspector },
      ...(connection ? [{ provide: BACKEND_CONNECTION, useValue: connection }] : []),
      provideBrowserGlobalErrorListeners(),
      provideOpenUiSandbox(),
      provideCopilotKit({
        runtimeUrl: `${backend.url}${RUNTIME_PATH}`,
        headers: { Authorization: `Bearer ${backend.token}` },
        selfManagedAgents: {
          pi: new ThreadReplayAgent({
            runtimeUrl: `${backend.url}${RUNTIME_PATH}`,
            agentId: 'pi',
            headers: { Authorization: `Bearer ${backend.token}` },
            transport: 'rest',
            runtimeMode: 'sse',
          }),
          // A background agent's transcript: the same replay transport, the agent's id as thread id.
          'pi-bg': new ThreadReplayAgent({
            runtimeUrl: `${backend.url}${RUNTIME_PATH}`,
            agentId: 'pi-bg',
            headers: { Authorization: `Bearer ${backend.token}` },
            transport: 'rest',
            runtimeMode: 'sse',
          }),
        },
        // <cpk-web-inspector> covers part of the page and takes pointer events, so it is off unless Settings › Advanced turns it on (read at load).
        enableInspector: inspector,
        // pi's built-in render_a2ui tool and bundled pi-ui skill supply its generation contract.
        // Browser-provided schemas/context are not forwarded to pi.
        a2ui: { catalog: piKitA2uiCatalog, includeSchema: false, loadingComponent: PkA2uiLoading },
        openGenerativeUI: {},
      }),
      // CopilotKit 0.6.0 only mounts the inspector when `isDevMode()`, and an explicit `enableInspector: true` does not override that; the packaged app is a
      // production build, so the switch also answers CopilotKit's (internal) development-mode token. Pinned with the package.
      ...(inspector ? [{ provide: ɵCOPILOTKIT_INSPECTOR_DEVELOPMENT_MODE, useValue: true }] : []),
      // MCP Apps: host info, capabilities and the idle timeout of apps. The transcript draws them with
      // `PkMcpApp`, which ranks above the stock renderer this also registers.
      provideMCPApps({ hostInfo: { name: 'pi-kit', version: '0.0.0' } }),
      // "Show thinking expanded" (Settings › Appearance): the thinking trace reads the preference when it is drawn.
      {
        provide: PK_THINKING_OPEN,
        useFactory: () => {
          const prefs = inject(ViewPrefs);
          return () => prefs.thinkingExpanded();
        },
      },
      // Ports: where two domains read each other, one of them declares an abstract class and the composition root provides the other's store, because
      // a library cannot import what imports it. `ThreadShell` is the shell store (it lives in the app); `WorktreeReview` is review mode's store, which imports
      // the threads; `ChatTree` and `ChatConnectors` are the session tree and the connectors, which import the chat.
      { provide: ThreadShell, useExisting: ShellStore },
      { provide: WorktreeReview, useExisting: ChangesStore },
      { provide: ChatTree, useExisting: GraphStore },
      { provide: ChatConnectors, useExisting: ConnectorsStore },
      // The transcript and the composer components, for the Agents panel's view of a background agent.
      { provide: TRANSCRIPT_VIEW, useValue: Transcript },
      { provide: AGENT_INPUT_VIEW, useValue: AgentInputContainer },
      // The page of a thread that has no message belongs to the threads domain and is a lazy chunk; the chat page asks for it when a new thread opens.
      {
        provide: EMPTY_THREAD_PAGE,
        useValue: () => import('@pi-kit/threads/feature-new-thread').then((m) => m.NewThreadPage),
      },
      {
        provide: NEW_THREAD_COMPOSER,
        useValue: () =>
          import('@pi-kit/threads/feature-new-thread').then((m) => ({ row: m.WhereRow, hint: m.WhereHint })),
      },
    ],
  };
}
