import type { ExtensionFactory, ToolInfo } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { RoomTools } from './room-tools';

type McpTool = Pick<ToolInfo, 'name' | 'annotations' | 'namespace'>;

/** `ask-owner`: an MCP tool that may change something waits for the owner's yes; `refuse`: it is refused (no one can answer). */
export type ReadOnlyMode = 'ask-owner' | 'refuse';

export class ReadOnlyTools {
  static readonly NAME = 'read-only-tools';
  static readonly TOOL_SEARCH = 'tool_search';
  static readonly CODEMODE = 'codemode';
  static readonly ALLOW = 'Allow';
  static readonly ALWAYS = 'Always allow this tool here';
  static readonly DECLINE = 'Decline';
  private static readonly COMMANDS =
    /^\s*(ls|cat|head|tail|wc|grep|rg|find|tree|pwd|echo|node --test|npm test|npm run (test|lint|check|typecheck)|pnpm (test|lint|check|typecheck)|pnpm run (test|lint|check|typecheck)|pnpm exec (vitest|jest|tsc|eslint|nx (test|lint))|npx (vitest|jest|tsc|eslint)|vitest|jest|tsc|eslint|pytest|python -m pytest|cargo (test|check|clippy)|go (test|vet)|git (status|diff|log|show|branch|ls-files|blame))(\s|$)/;
  private static readonly SHELL_OPERATORS = /[|;&>`]|\$\(/;
  private static readonly READERS = new Set<string>([
    'read',
    'ls',
    'find',
    'grep',
    ReadOnlyTools.TOOL_SEARCH,
    ...RoomTools.NAMES,
  ]);

  static commandAllowed(command: string): boolean {
    return ReadOnlyTools.COMMANDS.test(command) && !ReadOnlyTools.SHELL_OPERATORS.test(command);
  }

  private static mcpReader(tool: McpTool | undefined, servers: ReadonlySet<string>): boolean {
    if (!tool?.name.startsWith('mcp__')) return false;
    if (tool.annotations?.readOnlyHint === true) return true;
    return tool.namespace?.aliases?.some((server) => servers.has(server)) ?? false;
  }

  /** Tools outside the sandbox that a read-only thread may reach; this extension still decides on each MCP call. */
  static outsideSandbox(tool: Pick<ToolInfo, 'name'>): boolean {
    return tool.name === ReadOnlyTools.TOOL_SEARCH || tool.name.startsWith('mcp__');
  }

  private static question(tool: McpTool, input: unknown): string {
    const server = tool.namespace?.aliases?.[0];
    const name = tool.name.split('__').at(-1) ?? tool.name;
    const args = JSON.stringify(input ?? {}, null, 2);
    // A blank line splits the question from its detail; a room shows them apart (RoomQuestions.fromDialogs).
    return `The lead wants to run ${server ? `${server} · ` : ''}${name}, which may change something.\n\n${args.length > 1500 ? `${args.slice(0, 1500)}…` : args}`;
  }

  static block(
    toolName: string,
    input: unknown,
    tool?: McpTool,
    servers: ReadonlySet<string> = new Set(),
  ): string | undefined {
    if (ReadOnlyTools.READERS.has(toolName) || ReadOnlyTools.mcpReader(tool, servers)) return undefined;
    if (toolName === 'bash') {
      const command = String((input as { command?: unknown } | undefined)?.command ?? '');
      return ReadOnlyTools.commandAllowed(command)
        ? undefined
        : 'This session is read-only: only commands that read (ls, cat, grep, git status, git diff and the like) are allowed, without redirection.';
    }
    if (toolName === ReadOnlyTools.CODEMODE)
      return `This session is read-only: ${toolName} is not available. Find MCP tools with ${ReadOnlyTools.TOOL_SEARCH} and call the ones that only read directly.`;
    if (toolName.startsWith('mcp__'))
      return `This session is read-only: ${toolName} may change something, so it is not available. Only MCP tools their server marks read-only, and the tools of apps added read only, can be called here.`;
    return `This session is read-only: ${toolName} is not available. Answer in text and say what you would change instead.`;
  }

  static factory(servers: () => Promise<ReadonlySet<string>>, mode: ReadOnlyMode): ExtensionFactory {
    return (api) => {
      const always = new Set<string>();
      // Scripts cannot be checked call by call, so MCP tools are found with tool_search and called one at a time.
      api.on('before_agent_start', () => {
        const active = api.getActiveTools().filter((name) => name !== ReadOnlyTools.CODEMODE);
        const search = api.getAllTools().some((tool) => tool.name === ReadOnlyTools.TOOL_SEARCH);
        api.setActiveTools(
          search && !active.includes(ReadOnlyTools.TOOL_SEARCH) ? [...active, ReadOnlyTools.TOOL_SEARCH] : active,
        );
      });
      api.on('tool_call', async (event, ctx) => {
        const tool = event.toolName.startsWith('mcp__')
          ? api.getAllTools().find((candidate) => candidate.name === event.toolName)
          : undefined;
        const reason = ReadOnlyTools.block(event.toolName, event.input, tool, tool ? await servers() : new Set());
        if (!reason) return undefined;
        if (!tool || mode !== 'ask-owner') return { block: true, reason };
        if (always.has(tool.name)) return undefined;
        const choice = await ctx.ui.select(ReadOnlyTools.question(tool, event.input), [
          ReadOnlyTools.ALLOW,
          ReadOnlyTools.ALWAYS,
          ReadOnlyTools.DECLINE,
        ]);
        if (choice === ReadOnlyTools.ALWAYS) always.add(tool.name);
        return choice === ReadOnlyTools.ALLOW || choice === ReadOnlyTools.ALWAYS
          ? undefined
          : { block: true, reason: `The owner did not allow ${event.toolName}. Answer without it.` };
      });
    };
  }
}
