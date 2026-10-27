import { Logger } from '@nestjs/common';
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { PiUiEvent } from '@pi-kit/pi-adapter';
import { COMPOSER_CHANNEL } from '@pi-kit/protocol';
import type { PiModule } from './load-pi';
import { UiBridge } from './ui-bridge';

const logger = new Logger('SessionUi');

export interface SessionUiHooks {
  dialogsChanged(): void;
  unattached(event: PiUiEvent): void;
  treeChanged(): void;
  toolStarting(name: string, args: Record<string, unknown>): void;
}

/** pi keeps the active TUI theme in a global under this key (see `initTheme`). */
const PI_THEME_KEY = Symbol.for('@earendil-works/pi-coding-agent:theme');
const piTheme = new Proxy(
  {},
  {
    get(_target, prop) {
      const theme = (globalThis as Record<symbol, Record<string | symbol, unknown> | undefined>)[PI_THEME_KEY];
      if (!theme) throw new Error('Theme not initialized.');
      return theme[prop];
    },
  },
);

/** Create the host UI before extensions load, then bind the SDK session once it exists. */
export function createSessionUi(pi: Pick<PiModule, 'createEventBus'>, threadId: string, hooks: SessionUiHooks) {
  const ui = new UiBridge();
  ui.onChange(hooks.dialogsChanged);
  ui.onUnattached(hooks.unattached);
  const bus = pi.createEventBus();
  bus.on(COMPOSER_CHANNEL, (payload) => {
    try {
      if (!ui.registerComposer(payload)) logger.debug(`Dropped an invalid ${COMPOSER_CHANNEL} payload of thread ${threadId}: ${JSON.stringify(payload)?.slice(0, 200)}`);
    } catch (error) {
      logger.debug(`Could not relay a ${COMPOSER_CHANNEL} payload of thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return {
    ui,
    bus,
    async bind(session: AgentSession): Promise<void> {
      // Emits session_start, which connects the MCP servers. The UI context is ours: dialogs
      // become interrupts, notify / status / widget / title go to the run that is listening.
      await session.bindExtensions({
        uiContext: ui.context({ theme: piTheme }) as unknown as ExtensionUIContext,
        mode: 'rpc',
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          // Moving along the tree stays inside the file, so an extension may do it (the transcript follows through
          // `onTreeChanged`). Replacing the session would need the thread to move to another file; that reports "cancelled".
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async (targetId, options) => {
            const result = await session.navigateTree(targetId, options);
            if (!result.cancelled) hooks.treeChanged();
            return { cancelled: result.cancelled };
          },
          switchSession: async () => ({ cancelled: true }),
          reload: () => ui.reloading(() => session.reload()),
        },
        onError: (error) => logger.warn(`Extension error in ${error.extensionPath} (${error.event}): ${error.error}`),
      });
      // The changes view needs each file as it was before pi's first edit; the tool result does not carry it.
      session.subscribe((event) => {
        if (event.type !== 'tool_execution_start') return;
        hooks.toolStarting(String(event['toolName']), (event['args'] ?? {}) as Record<string, unknown>);
      });
      // Which tool is running: a dialog that a `tool_call` hook opens says "while running bash". pi starts the call (this event) before it runs the hooks.
      let activeTools: { id: string; name: string }[] = [];
      ui.activeTool = () => activeTools.at(-1)?.name;
      ui.activeToolCallId = () => activeTools.at(-1)?.id;
      session.subscribe((event) => {
        if (event.type === 'tool_execution_start') activeTools.push({ id: String(event['toolCallId']), name: String(event['toolName']) });
        else if (event.type === 'tool_execution_end') activeTools = activeTools.filter((t) => t.id !== String(event['toolCallId']));
      });
    },
  };
}
