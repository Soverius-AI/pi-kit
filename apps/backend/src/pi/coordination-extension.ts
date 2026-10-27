import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { PiModule } from './load-pi';

/** The `customType` of the message that tells pi another thread changed a file it knows. */
export const COORDINATION_NOTICE = 'pi-kit:coordination';

/** The key of the system-prompt section; pi wraps it as `<other_agents>...</other_agents>`. */
export const COORDINATION_SECTION = 'other_agents';

/**
 * What the coordination extension asks the backend. The backend implements it from the threads table and the file leases;
 * this file only wires it to pi's hooks, so the policy (who is listed, what counts as a change) stays testable without a pi session.
 */
export interface CoordinationHook {
  /** The text of "Other agents in this workspace" for the thread's next run, or `undefined` when no other agent is working here. */
  section(threadId: string): string | undefined;
  /** What other threads changed in files this thread knows, since the last time it was told: one line per file. Taking them marks them told. */
  notices(threadId: string): string[];
}

/**
 * The extension bound to every pi-kit session (inline, through `DefaultResourceLoader`):
 *
 * - `before_agent_start` sets or removes the "Other agents in this workspace" system-prompt section, and puts a `custom_message` in front of the
 *   model for files another thread changed since this thread last read them;
 * - `turn_end` does the same between the turns of a run that goes on (the model is about to make another request after its tool calls);
 * - the `bash` tool gets `PI_KIT=1` and `PI_KIT_THREAD_ID` in its environment, so user extensions and scripts can tell.
 */
export function createCoordinationExtension(pi: PiModule, options: { threadId: string; cwd: string; hook: () => CoordinationHook | undefined }): ExtensionFactory {
  const { threadId, cwd } = options;
  return (api: ExtensionAPI) => {
    api.registerTool(
      pi.createBashToolDefinition(cwd, {
        spawnHook: (context) => ({ ...context, env: { ...context.env, PI_KIT: '1', PI_KIT_THREAD_ID: threadId } }),
      }),
    );

    api.on('before_agent_start', (event) => {
      const hook = options.hook();
      if (!hook) return undefined;
      const section = hook.section(threadId);
      if (section) event.systemPromptOptions.sections[COORDINATION_SECTION] = section;
      else delete event.systemPromptOptions.sections[COORDINATION_SECTION];
      const notices = hook.notices(threadId);
      if (notices.length === 0) return undefined;
      return { message: { customType: COORDINATION_NOTICE, content: notices.join('\n'), display: true } };
    });

    api.on('turn_end', (event) => {
      // Only a turn with tool calls is followed by another request in the same run; after the last turn the notice waits for the next prompt.
      if (event.toolResults.length === 0) return undefined;
      const notices = options.hook()?.notices(threadId) ?? [];
      if (notices.length === 0) return undefined;
      return { entries: [{ type: 'custom_message', customType: COORDINATION_NOTICE, content: notices.join('\n'), display: true }] };
    });
  };
}
