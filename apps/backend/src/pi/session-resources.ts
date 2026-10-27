import { readFileSync } from 'node:fs';
import type { AgentSession } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { ChipResources } from '../agui/chip-expansion';
import { loadPi } from './load-pi';

/** One entry of the discovered-command list (pi's `get_commands`): extension commands, prompt templates and skills. */
export interface PiDiscoveredCommand {
  name: string;
  description: string | undefined;
  source: 'extension' | 'prompt' | 'skill';
  /** `user`, `project`, ... for skills and templates; the extension's file or package for extension commands. */
  scope: string | undefined;
  origin: string | undefined;
  path: string | undefined;
}

/** Commands from the session's current resources, including provenance for menu badges and suggestions. */
export function discoverSessionCommands(session: AgentSession): PiDiscoveredCommand[] {
  const out: PiDiscoveredCommand[] = [];
  const describe = (info: { source?: string; scope?: string; origin?: string; path?: string } | undefined) => ({
    scope: info?.scope,
    origin: info?.origin ?? info?.source,
    path: info?.path,
  });
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    out.push({ name: command.invocationName, description: command.description, source: 'extension', ...describe(command.sourceInfo) });
  }
  for (const template of session.promptTemplates) {
    out.push({ name: template.name, description: template.description, source: 'prompt', ...describe(template.sourceInfo) });
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    out.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill', ...describe(skill.sourceInfo) });
  }
  return out;
}

/** Live skills and prompt templates for chip expansion; the SDK remains the resource owner after reload. */
export async function sessionChipResources(session: AgentSession): Promise<ChipResources> {
  const pi = await loadPi();
  return {
    skills: session.resourceLoader.getSkills().skills.map((s) => ({ name: s.name, filePath: s.filePath, baseDir: s.baseDir })),
    templates: session.promptTemplates.map((t) => ({ name: t.name, content: t.content })),
    read: (path) => readFileSync(path, 'utf-8'),
    stripFrontmatter: pi.stripFrontmatter,
  };
}
