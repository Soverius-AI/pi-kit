import { registerRenderToolCall } from '@copilotkit/angular';
import { z } from 'zod';
import { AgentSpawnRow } from './agent-spawn-row';
import { AskRow } from './ask-row';
import { BashToolRow } from './bash-tool-row';
import { DefaultToolRow } from './default-tool-row';
import { EditToolRow } from './edit-tool-row';
import { ListToolRow } from './list-tool-row';
import { ReadToolRow } from './read-tool-row';

const anyArgs = z.object({}).passthrough();

/**
 * Registers the tool-call renderers with CopilotKit (`registerRenderToolCall`): one per
 * pi tool the transcript draws specially and a wildcard for the rest. Call from an injection context; the
 * registrations go away with it.
 */
export function registerToolRenderers(): void {
  const renderers = [
    ['read', ReadToolRow],
    ['edit', EditToolRow],
    ['write', EditToolRow],
    ['bash', BashToolRow],
    ['grep', ListToolRow],
    ['find', ListToolRow],
    ['ls', ListToolRow],
    ['agent_spawn', AgentSpawnRow],
    ['ask', AskRow],
    ['*', DefaultToolRow],
  ] as const;
  for (const [name, component] of renderers) {
    registerRenderToolCall({ name, args: anyArgs, component, agentId: 'pi' });
  }
}
