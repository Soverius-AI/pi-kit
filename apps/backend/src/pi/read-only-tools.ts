import type { ExtensionFactory } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { RoomTools } from './room-tools';

export class ReadOnlyTools {
  static readonly NAME = 'read-only-tools';
  private static readonly COMMANDS =
    /^\s*(ls|cat|head|tail|wc|grep|rg|find|tree|pwd|echo|node --test|npm test|npm run (test|lint|check|typecheck)|pnpm (test|lint|check|typecheck)|pnpm run (test|lint|check|typecheck)|pnpm exec (vitest|jest|tsc|eslint|nx (test|lint))|npx (vitest|jest|tsc|eslint)|vitest|jest|tsc|eslint|pytest|python -m pytest|cargo (test|check|clippy)|go (test|vet)|git (status|diff|log|show|branch|ls-files|blame))(\s|$)/;
  private static readonly SHELL_OPERATORS = /[|;&>`]|\$\(/;
  private static readonly READERS = new Set<string>(['read', 'ls', 'find', 'grep', ...RoomTools.NAMES]);

  static commandAllowed(command: string): boolean {
    return ReadOnlyTools.COMMANDS.test(command) && !ReadOnlyTools.SHELL_OPERATORS.test(command);
  }

  static block(toolName: string, input: unknown): string | undefined {
    if (ReadOnlyTools.READERS.has(toolName)) return undefined;
    if (toolName === 'bash') {
      const command = String((input as { command?: unknown } | undefined)?.command ?? '');
      return ReadOnlyTools.commandAllowed(command)
        ? undefined
        : 'This session is read-only: only commands that read (ls, cat, grep, git status, git diff and the like) are allowed, without redirection.';
    }
    return `This session is read-only: ${toolName} is not available. Answer in text and say what you would change instead.`;
  }

  static factory(): ExtensionFactory {
    return (api) => {
      api.on('tool_call', (event) => {
        const reason = ReadOnlyTools.block(event.toolName, event.input);
        return reason ? { block: true, reason } : undefined;
      });
    };
  }
}
