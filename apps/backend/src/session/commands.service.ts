import { Injectable } from '@nestjs/common';
import type { Command } from '@pi-kit/protocol';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { type PromptSuggestion, PromptSuggestionReader } from './prompt-suggestion';

/**
 * pi's built-in slash commands (`BUILTIN_SLASH_COMMANDS`, pi 1.4.0). The SDK declares the table but does not
 * export it at runtime, so it is copied here; `llama` is documented in pi's slash-commands.md
 * but missing from that table. `cost` and the commands after `llama` are pi-kit's own: pi shows costs inside `/session`, the app has a dialog for them.
 */
const BUILTINS: readonly { name: string; description: string; argumentHint?: string }[] = [
  { name: 'settings', description: 'Open settings menu', argumentHint: '[section]' },
  { name: 'model', description: 'Select model (opens selector UI)', argumentHint: '<provider/model>' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'thinking', description: 'Set thinking level', argumentHint: '<level>' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)', argumentHint: '[path]' },
  { name: 'import', description: 'Import and resume a session from a JSONL file', argumentHint: '<path>' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'bug', description: 'Report a bug to the Pi developers', argumentHint: '<description>' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name', argumentHint: '[name]' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'cost', description: 'Show usage and cost by model and by turn' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous user message' },
  { name: 'clone', description: 'Duplicate the current session at the current position' },
  { name: 'trust', description: 'Save project trust decision for future sessions' },
  { name: 'login', description: 'Configure provider authentication', argumentHint: '<provider>' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context', argumentHint: '[instructions]' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes, and context files' },
  { name: 'quit', description: 'Quit pi-kit' },
  { name: 'llama', description: 'Manage local models, Hugging Face downloads and llama-swap configuration' },
  // pi-kit's own: the sidebar's projects, the attendant and the first-run setup.
  { name: 'setup', description: 'Open the setup: sign in, add a key or a local model, pick defaults' },
  { name: 'connect', description: 'Connect Linear, GitHub, Slack, Notion and more: remote MCP servers with a one-click sign-in' },
  { name: 'project', description: 'Open the menu of the current project: new thread, fold, hide, move' },
  { name: 'worktree', description: 'Start a thread in its own git worktree (new), or sync it with its base branch and merge it back (sync, merge)', argumentHint: '[new|sync|merge]' },
  { name: 'attendant', description: 'Turn the attendant on or off for this project (activity: open what it did)', argumentHint: '[on|off|activity]' },
];

/** Built-ins the app does not implement: they stay in the menu, visibly disabled. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  share: 'Out of scope for pi-kit v1.',
  bug: 'Out of scope for pi-kit v1.',
};

/**
 * The one command registry: what pi discovered for the open session (extension commands, prompt
 * templates, skills; `kind: "prompt"`, the composer sends the text and pi expands or runs it) plus the
 * built-in TUI commands (`kind: "action"`, the UI dispatches them to REST endpoints or panels).
 */
@Injectable()
export class CommandsService {
  private readonly suggestions = new PromptSuggestionReader();

  constructor(
    private readonly threads: ThreadsService,
    private readonly sessions: PiSessionService,
  ) {}

  async list(threadId: string): Promise<Command[]> {
    await this.threads.openSession(threadId);
    return this.merge(this.sessions.commands(threadId), (path) => this.suggestions.read(path));
  }

  /**
   * Pure part of `list()`: discovered commands first, then the built-ins. `suggestion` tells whether the prompt template at a path
   * asks for a suggestion pill (`suggested: true` in its frontmatter).
   */
  merge(discovered: ReturnType<PiSessionService['commands']>, suggestion?: (path: string) => PromptSuggestion | undefined): Command[] {
    const commands: Command[] = discovered.map((c) =>
      // pi's MCP extension registers /mcp, which opens its TUI manager. Here it opens the MCP panel, a UI
      // action like the built-ins; the composer must not send it to pi as text.
      c.name === 'mcp' && c.source === 'extension'
        ? { name: 'mcp', description: 'Manage MCP servers: status, sign in, reconnect, enable or disable', source: 'extension', kind: 'action', origin: 'pi' }
        : {
            name: c.name,
            ...(c.description ? { description: c.description } : {}),
            source: c.source,
            kind: 'prompt',
            origin: originLabel(c),
            ...suggestionFields(c, suggestion),
          },
    );
    for (const builtin of BUILTINS) {
      const reason = UNAVAILABLE[builtin.name];
      commands.push({
        name: builtin.name,
        description: builtin.description,
        source: 'builtin',
        kind: 'action',
        ...(builtin.argumentHint ? { argumentHint: builtin.argumentHint } : {}),
        ...(reason ? { disabled: true, disabledReason: reason } : {}),
      });
    }
    return commands;
  }
}

/** The badge text: the skill's or template's scope, the extension's file name (without its extension). */
function originLabel(c: { source: string; scope: string | undefined; origin: string | undefined; path: string | undefined }): string | undefined {
  if (c.source === 'extension') {
    const file = c.path?.split('/').filter(Boolean);
    const name = file?.at(-1)?.replace(/\.[cm]?[jt]s$/, '');
    const label = name === 'index' ? file?.at(-2) : name;
    return label ?? c.origin ?? c.scope;
  }
  return c.scope ?? c.origin;
}

/** `suggested` and `suggestionTitle` for a prompt template whose frontmatter asks for them. */
function suggestionFields(
  c: { source: string; path: string | undefined },
  suggestion: ((path: string) => PromptSuggestion | undefined) | undefined,
): Pick<Command, 'suggested' | 'suggestionTitle'> {
  if (c.source !== 'prompt' || !c.path || !suggestion) return {};
  const found = suggestion(c.path);
  return found ? { suggested: true, ...(found.suggestionTitle ? { suggestionTitle: found.suggestionTitle } : {}) } : {};
}
