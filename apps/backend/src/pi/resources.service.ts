import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ResourceItem, ResourceType, ResourcesOverview } from '@pi-kit/protocol';
import { loadPi } from './load-pi';
import { TrustService } from './trust.service';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { BROWSER_SKILL_KEY, browserSkillPath } from './browser-extension';
import { GENUI_SKILL_KEY, genUiSkillPath } from './genui-extension';

type Pi = Awaited<ReturnType<typeof loadPi>>;
type Resolved = Awaited<ReturnType<InstanceType<Pi['DefaultPackageManager']>['resolve']>>;
type ResolvedResource = Resolved['extensions'][number];
type ResourceSettingsKey = 'extensions' | 'skills' | 'prompts';

const TYPES: readonly ResourceSettingsKey[] = ['extensions', 'skills', 'prompts'];

/** `~/.pi/agent` for the home folder’s sake; anything else as it is. */
function shortPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(home + '/') || path.startsWith(home + '\\') ? `~${path.slice(home.length).replace(/\\/g, '/')}` : path.replace(/\\/g, '/');
}

/**
 * The inventory behind Settings › Extensions and skills: every extension, skill and prompt template pi discovers for a folder,
 * with where it came from and whether it is on, and the switch. It uses pi’s own `DefaultPackageManager.resolve()` (what `pi config` lists) and
 * writes the same `-path` / `+path` entries pi’s config screen writes, so the CLI sees the result. Nothing is installed or downloaded: a package
 * that is not installed is skipped. Project resources are only read for a trusted folder.
 */
@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(private readonly trust: TrustService, @Optional() private readonly desktop?: DesktopBridge) {}

  async overview(cwd: string): Promise<ResourcesOverview> {
    const { pi, manager, packages, trusted, hasProject, agentDir } = await this.context(cwd);
    const errors: string[] = [];
    let resolved: Resolved;
    try {
      resolved = await packages.resolve(async () => 'skip');
    } catch (error) {
      errors.push(`pi could not list its resources: ${error instanceof Error ? error.message : String(error)}`);
      return { items: [], projectSkipped: hasProject && !trusted, errors };
    }
    for (const error of manager.drainErrors()) errors.push(error.error.message);
    const items: ResourceItem[] = [];
    const uiSkill = genUiSkillPath();
    items.push({ key: GENUI_SKILL_KEY, type: 'skills', name: 'pi-ui', path: uiSkill, enabled: true, scope: 'user', origin: 'builtin', source: 'builtin', label: 'Bundled with pi-kit', ...this.describe(pi, uiSkill) });
    if (this.desktop?.available) {
      const path = browserSkillPath();
      items.push({ key: BROWSER_SKILL_KEY, type: 'skills', name: 'pi-browser', path, enabled: true, scope: 'user', origin: 'builtin', source: 'builtin', label: 'Bundled with pi-kit', ...this.describe(pi, path) });
    }
    for (const type of TYPES) for (const res of resolved[type]) items.push(this.item(pi, type, res, agentDir, cwd));
    items.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
    return { items, ...(trusted && hasProject ? { projectCwd: cwd } : {}), projectSkipped: hasProject && !trusted, errors };
  }

  /** Turns one resource on or off in the settings file of its scope. */
  async toggle(cwd: string, key: string, enabled: boolean): Promise<ResourcesOverview> {
    if (key === GENUI_SKILL_KEY) throw new Error('The bundled UI skill accompanies pi-kit’s built-in UI tools.');
    if (key === BROWSER_SKILL_KEY) throw new Error('The bundled browser skill follows desktop browser availability.');
    const { pi, manager, packages, agentDir } = await this.context(cwd);
    const resolved = await packages.resolve(async () => 'skip');
    let target: { type: ResourceSettingsKey; res: ResolvedResource } | undefined;
    for (const type of TYPES) {
      const res = resolved[type].find((r) => this.keyOf(type, r) === key);
      if (res) target = { type, res };
    }
    if (!target) throw new Error('pi no longer lists that resource. Reload the list.');
    const { type, res } = target;
    const scope = res.metadata.scope === 'project' ? 'project' : 'user';
    if (res.metadata.source === 'builtin') throw new Error('Built-in extensions are switched in pi’s settings with -builtin:<name>.');
    const settings = scope === 'project' ? manager.getProjectSettings() : manager.getGlobalSettings();
    if (res.metadata.origin === 'package') {
      const packagesList = [...(settings.packages ?? [])];
      const index = packagesList.findIndex((p) => (typeof p === 'string' ? p : p.source) === res.metadata.source);
      if (index === -1) throw new Error(`The package ${res.metadata.source} is not in the ${scope} settings.`);
      const current = packagesList[index];
      const pkg = typeof current === 'string' ? { source: current } : { ...current };
      const pattern = relative(res.metadata.baseDir ?? dirname(res.path), res.path);
      const list = this.withPattern(((pkg as Record<string, unknown>)[type] ?? []) as string[], pattern, enabled);
      (pkg as Record<string, unknown>)[type] = list.length > 0 ? list : undefined;
      const hasFilters = TYPES.concat('themes' as never).some((k) => (pkg as Record<string, unknown>)[k] !== undefined);
      packagesList[index] = hasFilters ? (pkg as never) : pkg.source;
      if (scope === 'project') manager.setProjectPackages(packagesList);
      else manager.setPackages(packagesList);
    } else {
      const base = res.metadata.baseDir ?? (scope === 'project' ? join(cwd, pi.CONFIG_DIR_NAME) : agentDir);
      const pattern = relative(base, res.path);
      const list = this.withPattern(((settings as Record<string, unknown>)[type] ?? []) as string[], pattern, enabled);
      const setter = {
        user: { extensions: 'setExtensionPaths', skills: 'setSkillPaths', prompts: 'setPromptTemplatePaths' },
        project: { extensions: 'setProjectExtensionPaths', skills: 'setProjectSkillPaths', prompts: 'setProjectPromptTemplatePaths' },
      }[scope][type] as 'setExtensionPaths';
      manager[setter](list);
    }
    await manager.flush();
    const failures = manager.drainErrors();
    if (failures.length > 0) throw new Error(`pi could not save its settings: ${failures[0].error.message}`);
    this.logger.log(`${enabled ? 'Enabled' : 'Disabled'} ${type.slice(0, -1)} ${res.path} (${scope})`);
    return this.overview(cwd);
  }

  // ---- internals

  /** pi’s `-path` / `+path` entries: the old entry for the resource goes, the new one is appended (pi’s config screen does the same). */
  private withPattern(current: string[], pattern: string, enabled: boolean): string[] {
    const kept = current.filter((entry) => (/^[!+-]/.test(entry) ? entry.slice(1) : entry) !== pattern);
    return [...kept, `${enabled ? '+' : '-'}${pattern}`];
  }

  private async context(cwd: string) {
    const pi = await loadPi();
    const agentDir = pi.getAgentDir();
    const state = await this.trust.state(cwd);
    const trusted = state.status === 'trusted';
    const manager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
    const packages = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: manager, builtinExtensions: [] });
    return { pi, agentDir, manager, packages, trusted, hasProject: state.hasResources };
  }

  private keyOf(type: ResourceSettingsKey, res: ResolvedResource): string {
    return `${type}:${res.metadata.scope}:${res.metadata.origin}:${res.metadata.source}:${res.path}`;
  }

  private item(pi: Pi, type: ResourceSettingsKey, res: ResolvedResource, agentDir: string, cwd: string): ResourceItem {
    const { metadata } = res;
    const scope = metadata.scope === 'project' ? 'project' : 'user';
    const file = basename(res.path);
    const folder = basename(dirname(res.path));
    let name: string;
    if (type === 'skills' && file === 'SKILL.md') name = folder;
    else if (type === 'extensions' && !['extensions', 'index.ts', 'index.js'].includes(folder) && /^index\.[tj]s$/.test(file)) name = folder;
    else name = file.replace(/\.(md|ts|js|mjs)$/, '');
    const origin = metadata.source === 'builtin' ? 'builtin' : metadata.origin;
    let label: string;
    if (metadata.origin === 'package') label = metadata.source;
    else if (metadata.source === 'builtin') label = 'Built-in';
    else if (scope === 'project') label = `Project (${metadata.baseDir && metadata.baseDir !== join(cwd, pi.CONFIG_DIR_NAME) ? shortPath(metadata.baseDir) : `${pi.CONFIG_DIR_NAME}/`})`;
    else label = `User (${shortPath(metadata.baseDir ?? agentDir)})`;
    return {
      key: this.keyOf(type, res),
      type: type as ResourceType,
      name,
      ...(type !== 'extensions' ? this.describe(pi, res.path) : {}),
      path: res.path,
      enabled: res.enabled,
      scope,
      origin,
      source: metadata.source,
      label,
    };
  }

  /** A skill’s or prompt template’s own `description:` line, if its file has frontmatter. */
  private describe(pi: Pi, path: string): { description?: string } {
    try {
      const { frontmatter } = pi.parseFrontmatter<{ description?: unknown }>(readFileSync(path, 'utf8'));
      return typeof frontmatter.description === 'string' && frontmatter.description.trim() ? { description: frontmatter.description.trim().slice(0, 240) } : {};
    } catch {
      return {};
    }
  }
}
