import type { BashOperations, ExtensionFactory } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type { PiModule } from './load-pi';
import { type SandboxClient, SandboxPackage, type ThreadProtectionService } from './thread-protection.service';

/** The tools of a sandboxed thread: pi's file and shell tools routed through its sandbox, every other tool refused unless reviewed. */
export class ThreadProtectionExtension {
  static readonly NAME = 'thread-protection';
  static readonly SOURCE = `<inline:${ThreadProtectionExtension.NAME}>`;
  private static readonly HOST_TOOLS = new Set([
    'render_a2ui',
    'generateSandboxedUi',
    'ask_user',
    'agent_spawn',
    'agent_send',
    'agent_list',
    'agent_wait',
    'agent_stop',
    'agent_reply',
    'agent_forward',
  ]);

  /** `bash` serves the `!command` shell of the session, which pi runs without an extension event; `tools` are the names routed through the sandbox. */
  static async create(
    pi: PiModule,
    options: { threadId: string; cwd: string; client: SandboxClient; protection: ThreadProtectionService },
  ): Promise<{ factory: ExtensionFactory; bash: BashOperations; tools: string[] }> {
    const { threadId, cwd, client, protection } = options;
    const generation = protection.binding(threadId).generation;
    const sandbox = { client, cwd, assertCurrent: () => protection.assertCurrent(threadId, generation) };
    const { PiSandbox } = await SandboxPackage.load('pi');
    const definitions = PiSandbox.toolDefinitions(pi, sandbox);
    const tools = definitions.map((definition) => definition.name);
    const routed = new Set(tools);
    return {
      bash: PiSandbox.operations(sandbox).bash,
      tools,
      factory: (api) => {
        for (const definition of definitions) api.registerTool(definition);
        api.on('before_agent_start', () => sandbox.assertCurrent());
        api.on('tool_call', (event) => {
          sandbox.assertCurrent();
          if (!routed.has(event.toolName))
            return ThreadProtectionExtension.HOST_TOOLS.has(event.toolName)
              ? undefined
              : { block: true, reason: `${event.toolName} is not available in a sandboxed thread.` };
          const source = api.getAllTools().find((tool) => tool.name === event.toolName)?.sourceInfo.path;
          return source === ThreadProtectionExtension.SOURCE
            ? undefined
            : { block: true, reason: `Another extension replaced the sandboxed ${event.toolName} tool.` };
        });
      },
    };
  }
}
