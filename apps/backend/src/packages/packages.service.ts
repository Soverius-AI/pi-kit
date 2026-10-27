import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PACKAGE_KINDS,
  type InstallPackage,
  type PackageActionResult,
  type PackageBrings,
  type PackageDetail,
  type PackageItem,
  type PackageKind,
  type PackageOutdated,
  type PackageSearchKind,
  type PackageSearchResponse,
  type PackageSearchResult,
  type PackagesOverview,
  installCommand,
  originOfSource,
} from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { loadPi } from '../pi/load-pi';
import { PiSessionService } from '../pi/pi-session.service';
import { isNewerVersion } from '../pi/version';
import { TrustService } from '../pi/trust.service';
import { UpdateService } from '../update/update.service';
import { SearchCache, bringsOfManifest, getJson, matchesKind, packumentUrl, parsePackument, parseSearch, readmeUrlOfGit, registryOf, README_LIMIT, REGISTRY_TIMEOUT_MS, searchUrl } from './npm-registry';
import {
  BUNDLED_PACKAGES,
  type PackageEntry,
  emptyBrings,
  entryWithEnabled,
  folderOf,
  groupBrings,
  isEntryEnabled,
  nameOfSource,
  normalizeSource,
  originOf,
  addResource,
  sourceIdentity,
  sourceOfEntry,
} from './package-rules';

type Pi = Awaited<ReturnType<typeof loadPi>>;

interface Context {
  pi: Pi;
  cwd: string;
  trusted: boolean;
  settings: ReturnType<Pi['SettingsManager']['create']>;
  manager: InstanceType<Pi['DefaultPackageManager']>;
}

interface Row {
  scope: 'user' | 'project';
  entry: PackageEntry;
}

/** The packages that ship with the app, by folder and the variable a test or a checkout can name their folder with. */
const BUNDLED_FOLDERS = [
  { folder: 'pi-kit-learn', env: 'PI_KIT_LEARN_PACKAGE_DIR' },
  { folder: 'pi-kit-meat-proxy', env: 'PI_KIT_MEAT_PROXY_PACKAGE_DIR' },
  { folder: 'pi-computer-use', env: 'PI_KIT_COMPUTER_USE_PACKAGE_DIR' },
] as const;

const idOf = (scope: 'user' | 'project', source: string): string => `${scope}:${source}`;

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * Packages in Settings › Extensions and skills: the list from pi's settings with what each brings, the install/update/remove through pi's own package manager
 * (`pi install`, in effect), the check for updates (pi's `checkForAvailableUpdates`, the same question the Updates section asks), and the search and detail of the "Add a package" wizard.
 * Sessions are reloaded after a change so the open threads see it. Nothing here runs a package's code; pi does that when a session loads it.
 */
@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);
  private readonly cache = new SearchCache();
  private outdatedIds = new Map<string, PackageOutdated>();
  private checkedAt: number | undefined;

  constructor(
    private readonly sessions: PiSessionService,
    private readonly trust: TrustService,
    private readonly updates: UpdateService,
    @Inject(CONFIG) private readonly backend: BackendConfig,
  ) {}

  private async context(cwd: string, trusted?: boolean): Promise<Context> {
    const pi = await loadPi();
    const isTrusted = trusted ?? (await this.trust.state(cwd)).status === 'trusted';
    const settings = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: isTrusted });
    const manager = new pi.DefaultPackageManager({ cwd, agentDir: pi.getAgentDir(), settingsManager: settings, builtinExtensions: [] });
    return { pi, cwd, trusted: isTrusted, settings, manager };
  }

  /** What a settings entry stands for. A folder is written relative to the settings file that holds it (`../pkg`), so it is resolved against that file's folder. */
  private identity(ctx: Context, scope: 'user' | 'project', source: string): string {
    const base = scope === 'project' ? join(ctx.cwd, '.pi') : ctx.pi.getAgentDir();
    return sourceIdentity(source, base);
  }

  private rows(ctx: Context): Row[] {
    const user = (ctx.settings.getGlobalSettings().packages ?? []) as PackageEntry[];
    const project = ctx.trusted ? ((ctx.settings.getProjectSettings().packages ?? []) as PackageEntry[]) : [];
    return [...user.map((entry) => ({ scope: 'user' as const, entry })), ...project.map((entry) => ({ scope: 'project' as const, entry }))];
  }

  // ---- the list

  async list(cwd: string): Promise<PackagesOverview> {
    return this.overview(await this.context(cwd));
  }

  private async overview(ctx: Context): Promise<PackagesOverview> {
    const errors: string[] = [];
    let groups = new Map<string, PackageBrings>();
    try {
      groups = groupBrings(await ctx.manager.resolve(async () => 'skip'));
    } catch (error) {
      errors.push(`pi could not list what the packages bring: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const failure of ctx.settings.drainErrors()) errors.push(failure.error.message);
    const configured = ctx.manager.listConfiguredPackages();
    const packages = this.rows(ctx).map(({ scope, entry }): PackageItem => {
      const source = sourceOfEntry(entry);
      const path = configured.find((c) => c.scope === scope && c.source === source)?.installedPath;
      const installed = !!path && existsSync(path);
      const manifest = installed && path ? readJson(join(path, 'package.json')) : undefined;
      const name = str(manifest?.['name']) ?? nameOfSource(source);
      const origin = originOf(source, str(manifest?.['name']));
      const id = idOf(scope, source);
      const outdated = this.outdatedIds.get(id);
      let installedAt: number | undefined;
      if ((origin === 'npm' || origin === 'git') && installed && path) {
        try {
          const stat = statSync(path);
          installedAt = stat.birthtimeMs || stat.mtimeMs;
        } catch {
          // no date
        }
      }
      return {
        id,
        source,
        name,
        ...(str(manifest?.['version']) ? { version: str(manifest?.['version']) } : {}),
        ...(str(manifest?.['description']) ? { description: str(manifest?.['description']) } : {}),
        scope,
        origin,
        enabled: isEntryEnabled(entry),
        installed,
        ...(path ? { path } : {}),
        ...(installedAt ? { installedAt } : {}),
        brings: groups.get(`${scope}:${source}`) ?? emptyBrings(),
        ...(outdated ? { outdated } : {}),
      };
    });
    return { packages, ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}), errors };
  }

  private async find(ctx: Context, id: string): Promise<Row & { source: string }> {
    const row = this.rows(ctx).find((r) => idOf(r.scope, sourceOfEntry(r.entry)) === id);
    if (!row) throw new NotFoundException('pi does not list that package any more. Reload the list.');
    return { ...row, source: sourceOfEntry(row.entry) };
  }

  // ---- install, update, remove, switch

  async install(cwd: string, body: InstallPackage): Promise<PackageActionResult> {
    const scope = body.scope ?? 'user';
    if (scope === 'project' && !(await this.trust.folderTrusted(cwd))) throw new ConflictException('This folder is not trusted yet, so pi would not read its .pi/settings.json. Trust the folder first, or install for every project.');
    const ctx = await this.context(cwd, scope === 'project' ? true : undefined);
    let source = normalizeSource(body.source);
    const problem = sourceProblem(source);
    if (problem) throw new BadRequestException(problem);
    if (originOfSource(source) === 'folder') {
      const folder = folderOf(source, cwd);
      this.requireLocalPackage(folder);
      source = folder;
    }
    const identity = sourceIdentity(source, cwd);
    if (this.rows(ctx).some((r) => r.scope === scope && this.identity(ctx, r.scope, sourceOfEntry(r.entry)) === identity)) throw new ConflictException(`${nameOfSource(source)} is installed already${scope === 'project' ? ' in this project' : ''}.`);
    try {
      await ctx.manager.installAndPersist(source, { local: scope === 'project' });
      await ctx.settings.flush();
    } catch (error) {
      throw new BadRequestException(`pi could not install ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const failures = ctx.settings.drainErrors();
    if (failures.length > 0) throw new BadRequestException(`pi could not save its settings: ${failures[0].error.message}`);
    this.logger.log(`Installed ${source} (${scope}).`);
    const reloaded = await this.sessions.reloadIdleSessions();
    const overview = await this.overview(await this.context(cwd));
    const item = overview.packages.find((p) => p.scope === scope && this.identity(ctx, p.scope, p.source) === identity);
    return { message: `Installed ${item?.name ?? nameOfSource(source)}${item?.version ? ` ${item.version}` : ''}.${reloaded > 0 ? ` ${reloaded} open ${reloaded === 1 ? 'thread' : 'threads'} reloaded.` : ''}`, overview, reloaded };
  }

  async remove(cwd: string, id: string): Promise<PackageActionResult> {
    const ctx = await this.context(cwd);
    const { scope, source } = await this.find(ctx, id);
    const name = (await this.overview(ctx)).packages.find((p) => p.id === id)?.name ?? nameOfSource(source);
    try {
      await ctx.manager.removeAndPersist(source, { local: scope === 'project' });
      await ctx.settings.flush();
    } catch (error) {
      throw new BadRequestException(`pi could not remove ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.outdatedIds.delete(id);
    const reloaded = await this.sessions.reloadIdleSessions();
    return { message: `Removed ${name}.`, overview: await this.overview(await this.context(cwd)), reloaded };
  }

  async update(cwd: string, id: string): Promise<PackageActionResult> {
    const ctx = await this.context(cwd);
    const { source } = await this.find(ctx, id);
    const before = (await this.overview(ctx)).packages.find((p) => p.id === id);
    const from = this.outdatedIds.get(id)?.current ?? before?.version;
    try {
      await ctx.manager.update(source);
      await ctx.settings.flush();
    } catch (error) {
      throw new BadRequestException(`pi could not update ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.outdatedIds.delete(id);
    const reloaded = await this.sessions.reloadIdleSessions();
    const overview = await this.overview(await this.context(cwd));
    const after = overview.packages.find((p) => p.id === id);
    const moved = from && after?.version && from !== after.version ? ` ${from} → ${after.version}` : '';
    return { message: `Updated ${after?.name ?? nameOfSource(source)}${moved}.`, overview, reloaded };
  }

  /** On or off: pi keeps the entry and loads nothing from an off package (every resource kind filtered to none). The open threads read it at their next Reload, like any resource switch. */
  async setEnabled(cwd: string, id: string, enabled: boolean): Promise<PackagesOverview> {
    const ctx = await this.context(cwd);
    const { scope, source } = await this.find(ctx, id);
    const list = [...((scope === 'project' ? ctx.settings.getProjectSettings().packages : ctx.settings.getGlobalSettings().packages) ?? [])] as PackageEntry[];
    const index = list.findIndex((entry) => sourceOfEntry(entry) === source);
    list[index] = entryWithEnabled(list[index], enabled);
    if (scope === 'project') ctx.settings.setProjectPackages(list as never);
    else ctx.settings.setPackages(list as never);
    await ctx.settings.flush();
    const failures = ctx.settings.drainErrors();
    if (failures.length > 0) throw new BadRequestException(`pi could not save its settings: ${failures[0].error.message}`);
    return this.overview(await this.context(cwd));
  }

  // ---- updates

  /** Asks pi which packages have a newer version or commit, adds the newest version npm knows, and keeps the answer for the list. */
  async outdated(cwd: string): Promise<PackagesOverview> {
    const ctx = await this.context(cwd);
    const { packages } = await this.overview(ctx);
    const found = new Map<string, PackageOutdated>();
    const skipped = !!(process.env['PI_OFFLINE'] || process.env['PI_SKIP_VERSION_CHECK']);
    if (!skipped) {
      const updates = await this.updates.packageUpdates({ cwd, projectTrusted: ctx.trusted });
      for (const update of updates) {
        const item = packages.find((p) => p.scope === update.scope && this.identity(ctx, p.scope, p.source) === this.identity(ctx, p.scope, update.source));
        if (!item) continue;
        const latest = item.origin === 'npm' ? await this.latestVersion(item.name) : undefined;
        found.set(item.id, { ...(item.version ? { current: item.version } : {}), ...(latest ? { latest } : {}) });
      }
    }
    // The test hook (never in production): the version a package is said to have, so the end-to-end test can see a chip without a registry.
    for (const [name, latest] of Object.entries(latestOverrides())) {
      const item = packages.find((p) => p.name === name || p.source === name);
      if (item?.version && isNewerVersion(latest, item.version)) found.set(item.id, { current: item.version, latest });
    }
    this.outdatedIds = found;
    this.checkedAt = Date.now();
    return this.overview(await this.context(cwd));
  }

  private async latestVersion(name: string): Promise<string | undefined> {
    try {
      const manifest = await getJson(`${packumentUrl(name, registryOf())}/latest`);
      return typeof manifest === 'object' && manifest !== null ? str((manifest as Record<string, unknown>)['version']) : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- the wizard

  async search(query: string, kind: PackageSearchKind | undefined, cwd: string): Promise<PackageSearchResponse> {
    const q = query.trim();
    const ctx = await this.context(cwd);
    const have = new Set(this.rows(ctx).map((r) => this.identity(ctx, r.scope, sourceOfEntry(r.entry))));
    const bundled = this.bundledResults(q);
    let remote: { results: PackageSearchResult[]; total: number } = { results: [], total: 0 };
    let error: string | undefined;
    try {
      remote = await this.cache.get(q, async () => parseSearch(await getJson(searchUrl(q, registryOf()))));
    } catch (e) {
      error = `${e instanceof Error ? e.message : String(e)} The packages that ship with pi-kit are listed below.`;
    }
    const names = new Set(bundled.map((b) => b.name));
    const results = [...bundled, ...remote.results.filter((r) => !names.has(r.name))]
      .filter((r) => matchesKind(r, kind))
      .map((r) => ({ ...r, installed: have.has(sourceIdentity(r.source, cwd)) || have.has(`npm:${r.name}`) }));
    return { results, total: remote.total + bundled.length, ...(error ? { error } : {}) };
  }

  private bundledDirs(): { dir: string; folder: string }[] {
    const found: { dir: string; folder: string }[] = [];
    for (const { folder, env } of BUNDLED_FOLDERS) {
      const candidates = [process.env[env], join(__dirname, 'packages', folder), resolve(__dirname, '..', '..', '..', '..', 'packages', folder), join(process.cwd(), 'packages', folder)].filter((d): d is string => !!d);
      const dir = candidates.find((d) => {
        const name = str(readJson(join(d, 'package.json'))?.['name']);
        return !!name && (BUNDLED_PACKAGES as readonly string[]).includes(name);
      });
      if (dir) found.push({ dir, folder });
    }
    return found;
  }

  private bundledResults(q: string): PackageSearchResult[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const results: PackageSearchResult[] = [];
    for (const { dir } of this.bundledDirs()) {
      const manifest = readJson(join(dir, 'package.json'));
      const name = str(manifest?.['name']);
      const version = str(manifest?.['version']);
      if (!manifest || !name || !version) continue;
      const keywords = Array.isArray(manifest['keywords']) ? manifest['keywords'].filter((k): k is string => typeof k === 'string') : [];
      const description = str(manifest['description']);
      const haystack = `${name} ${description ?? ''} ${keywords.join(' ')} pi-kit`.toLowerCase();
      if (!words.every((w) => haystack.includes(w))) continue;
      const brings = bringsOfManifest(manifest['pi']) ?? { extensions: 0, skills: 0, prompts: 0, themes: 0 };
      results.push({
        name,
        source: dir,
        version,
        ...(description ? { description } : {}),
        ...(str(manifest['license']) ? { license: str(manifest['license']) } : {}),
        author: 'pi-kit',
        contains: PACKAGE_KINDS.filter((k) => brings[k] > 0),
        exact: true,
        brings,
        bundled: true,
      });
    }
    return results;
  }

  async detail(source: string, cwd: string): Promise<PackageDetail> {
    const typed = normalizeSource(source);
    const origin = originOfSource(typed);
    const ctx = await this.context(cwd);
    const installed = this.rows(ctx).some((r) => this.identity(ctx, r.scope, sourceOfEntry(r.entry)) === sourceIdentity(typed, cwd));
    const notes: string[] = [];
    const base = { source: typed, command: installCommand(typed), installed };
    if (origin === 'folder') {
      const folder = folderOf(typed, cwd);
      this.requireLocalPackage(folder);
      const manifest = readJson(join(folder, 'package.json'));
      let brings: PackageBrings | undefined;
      try {
        const resolved = await ctx.manager.resolveExtensionSources([folder], { local: false, temporary: true });
        brings = groupAll(resolved);
      } catch (error) {
        notes.push(`pi could not read what the folder adds: ${error instanceof Error ? error.message : String(error)}`);
      }
      const readme = ['README.md', 'readme.md', 'README'].map((f) => join(folder, f)).find((f) => existsSync(f));
      return {
        ...base,
        source: folder,
        command: installCommand(folder),
        origin: originOf(folder, str(manifest?.['name'])),
        name: str(manifest?.['name']) ?? nameOfSource(folder),
        ...(str(manifest?.['version']) ? { version: str(manifest?.['version']) } : {}),
        ...(str(manifest?.['description']) ? { description: str(manifest?.['description']) } : {}),
        ...(str(manifest?.['license']) ? { license: str(manifest?.['license']) } : {}),
        ...(brings ? { brings } : {}),
        ...(readme ? { readme: readFileSync(readme, 'utf8').slice(0, README_LIMIT) } : {}),
        notes: readme ? notes : [...notes, 'This folder has no README.'],
      };
    }
    if (origin === 'npm') {
      const name = sourceIdentity(typed).slice(4);
      const pinned = typed.slice(4).lastIndexOf('@') > 0 ? typed.slice(4).slice(typed.slice(4).lastIndexOf('@') + 1) : undefined;
      try {
        const json = await getJson(packumentUrl(name, registryOf()), undefined, REGISTRY_TIMEOUT_MS);
        const doc = parsePackument(json, pinned);
        const brings = doc.brings ? withNames(doc.brings) : undefined;
        if (!brings) notes.push('The registry does not say what this package adds; it is listed after the install.');
        if (!doc.readme) notes.push('The package has no README on the registry.');
        const { brings: _brings, ...rest } = doc;
        return { ...base, origin: 'npm', ...rest, ...(brings ? { brings } : {}), notes };
      } catch (error) {
        return { ...base, origin: 'npm', name, notes: [error instanceof Error ? error.message : String(error), 'The install still works if the registry answers then.'] };
      }
    }
    // git
    const url = readmeUrlOfGit(typed);
    let readme: string | undefined;
    if (url) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (response.ok) readme = (await response.text()).slice(0, README_LIMIT);
          else notes.push(`The repository’s README was not found (${response.status}).`);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        notes.push('The repository’s README could not be fetched.');
      }
    } else notes.push('pi clones this repository when you install; its README is shown for repositories on GitHub.');
    notes.push('What a repository adds is known once pi has cloned it.');
    return { ...base, origin: 'git', name: nameOfSource(typed), ...(readme ? { readme } : {}), notes };
  }

  private requireLocalPackage(folder: string): void {
    if (!existsSync(folder)) throw new BadRequestException(`${folder} does not exist.`);
    const stat = statSync(folder);
    if (stat.isFile()) {
      if (!/\.(ts|js|mjs|cjs)$/.test(folder)) throw new BadRequestException('A single file has to be an extension (.ts or .js).');
      return;
    }
    const manifest = readJson(join(folder, 'package.json'));
    const conventional = PACKAGE_KINDS.some((kind) => existsSync(join(folder, kind)));
    if (!manifest && !conventional) throw new BadRequestException(`${folder} is not a pi package: it has no package.json and no extensions, skills, prompts or themes folder.`);
    if (manifest && !manifest['pi'] && !conventional) throw new BadRequestException(`${folder} has a package.json without a "pi" key and no extensions, skills, prompts or themes folder, so pi would load nothing from it.`);
  }
}

/** What is wrong with a source before pi is asked: an npm name that is none, a git address without a repository. Undefined when it looks installable (pi has the last word). */
export function sourceProblem(source: string): string | undefined {
  switch (originOfSource(source)) {
    case 'npm':
      return /^npm:(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(?:@[^\s@]+)?$/i.test(source) ? undefined : 'An npm source is npm:name or npm:@scope/name, optionally with @version.';
    case 'git':
      return /^(?:git:|git\+)?(?:(?:https?|ssh):\/\/)?(?:git@)?[a-z0-9.-]+[/:][^\s/]+\/[^\s]+$/i.test(source) ? undefined : 'A git source is a repository address: git:github.com/owner/name or https://github.com/owner/name.';
    default:
      return undefined;
  }
}

/** A folder's resources (`resolveExtensionSources`) as the counts of a package. */
function groupAll(resolved: Record<PackageKind, readonly { path: string }[]>): PackageBrings {
  const brings = emptyBrings();
  for (const kind of PACKAGE_KINDS) for (const res of resolved[kind]) addResource(brings, kind, res.path);
  return brings;
}

/** Counts from a registry's `pi` key as the package shape (the names are not known there). */
function withNames(counts: Record<PackageKind, number>): PackageBrings {
  return { ...counts, names: { extensions: [], skills: [], prompts: [], themes: [] } };
}

/** `PI_KIT_PACKAGE_LATEST`: `{ "<package name>": "<version>" }`, development only. */
export function latestOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env['NODE_ENV'] === 'production' || !env['PI_KIT_PACKAGE_LATEST']) return {};
  try {
    const parsed: unknown = JSON.parse(env['PI_KIT_PACKAGE_LATEST']);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  } catch {
    return {};
  }
}
