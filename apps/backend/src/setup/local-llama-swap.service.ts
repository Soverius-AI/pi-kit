import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InstalledLocalModelSchema, checkLlamaSwapYaml, LocalModelOptionsSaveSchema, type LocalModelReload, type LocalModelOptionsSave, type LocalModelOptions, type InstalledLocalModel, type LocalLlamaSwapConfig, type LocalConfigFile, type LocalDoctor, type LocalDoctorIssue, type LocalRepair } from '@pi-kit/protocol';
import { isMap, parseDocument, type YAMLMap, type Document } from 'yaml';
import { z } from 'zod';
import { MetaRepository } from '../db/meta.repository';
import { localExecutable } from './local-hardware.service';
import { discoverLlamaSwapConfigs, type DiscoveredLlamaSwapConfig } from './local-llama-swap-discovery';
import { readLlamaSwapDocument, readLlamaSwapModels, readLlamaSwapText } from './local-llama-swap-config';
import { inspectModels, repairModels } from './local-llama-swap-doctor';
import { readModelOptions, patchModelOptions, modelCommandInfo } from './local-model-options';
import { detectModelMtp } from './local-model-mtp';
import { reloadExistingModel } from './local-model-reload';

const RegistrationSchema = z.object({ configPath: z.string(), name: z.string(), model: InstalledLocalModelSchema });
type Registration = z.infer<typeof RegistrationSchema>;
const quote = (path: string): string => {
  if (/[\r\n\0]/.test(path)) throw new Error('This model path contains unsupported control characters. Move it to another folder.');
  return `'${path.replace(/'/g, `'\\''`)}'`;
};

const refersToModel = (cmd: unknown, path: string): boolean => typeof cmd === 'string' &&
  (cmd.includes(quote(path)) || cmd.includes(JSON.stringify(path)) || (!/\s/.test(path) && cmd.split(/\s+/).includes(path)));

/** Edits the user's existing configuration. It never starts, stops or owns a llama-swap process. */
@Injectable()
export class LocalLlamaSwapService {
  private target = '';
  private discovery?: { at: number; paths: DiscoveredLlamaSwapConfig[] };
  private targetModels: string[] = [];
  private registrations: Registration[];
  constructor(private readonly meta: MetaRepository) {
    const saved = RegistrationSchema.array().safeParse(meta.getSetting('local-runtime-config-models'));
    this.registrations = saved.success ? saved.data : [];
  }

  externalConfigPath(): string {
    const saved = this.meta.getSetting('local-runtime-external-config');
    return typeof saved === 'string' ? saved : '';
  }
  private expand(path: string): string {
    return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  }
  private defaultPath(): string {
    return join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'llama-swap', 'config.yaml');
  }
  private async previousDownloads(targetPath: string): Promise<InstalledLocalModel[]> {
    const previous = InstalledLocalModelSchema.array().safeParse(this.meta.getSetting('local-runtime-models'));
    const models: InstalledLocalModel[] = [];
    const destinationIds = new Set(this.registrations.filter((entry) => entry.configPath === targetPath).map((entry) => entry.model.id));
    const known = new Map([...(previous.success ? previous.data : []), ...this.registrations.filter((entry) => !destinationIds.has(entry.model.id)).map((entry) => entry.model)].map((model) => [model.id, model]));
    for (const model of known.values()) {
      if (await stat(model.path).then((info) => info.isFile()).catch(() => false)) models.push(model);
    }
    return models;
  }

  async selectConfig(input: string): Promise<void> {
    if (!input.trim()) {
      this.meta.setSetting('local-runtime-external-config', '');
      await this.readConfigs();
      return;
    }
    const path = this.expand(input.trim());
    if (!isAbsolute(path)) throw new Error('Use the full path or ~/path to a llama-swap config.');
    await readLlamaSwapModels(path);
    const canonical = await realpath(path);
    // Move existing downloaded-file registrations to the chosen shared config without touching the old private file.
    const previous = await this.previousDownloads(canonical);
    if (previous.length) await this.addModels(canonical, previous);
    this.meta.setSetting('local-runtime-external-config', resolve(path));
    await this.readConfigs();
  }

  async readConfigs(force = false): Promise<LocalLlamaSwapConfig[]> {
    if (force || !this.discovery || Date.now() - this.discovery.at > 30_000) {
      const discovered = await discoverLlamaSwapConfigs();
      const saved = z.array(z.object({ path: z.string(), source: z.enum(['Running llama-swap', 'Service configuration']) })).safeParse(this.meta.getSetting('local-runtime-discovered-configs'));
      // Keep only paths, never process command lines. This survives stopping the service or restarting pi-kit.
      const paths = [...new Map([...discovered.map(({ path, source }) => ({ path, source })), ...(saved.success ? saved.data : [])].map((entry) => [entry.path, entry])).values()].slice(0, 256);
      this.discovery = { at: Date.now(), paths: discovered };
      if (discovered.length) this.meta.setSetting('local-runtime-discovered-configs', paths);
    }
    const discovered = this.discovery.paths;
    const cached = z.array(z.object({ path: z.string(), source: z.string() })).safeParse(this.meta.getSetting('local-runtime-discovered-configs'));
    const remembered = cached.success ? cached.data : [];
    const explicit = [this.externalConfigPath(), process.env['PI_KIT_LLAMA_SWAP_CONFIG'], process.env['LLAMA_SWAP_CONFIG']]
      .filter((path): path is string => !!path).map((path) => resolve(this.expand(path)));
    const candidates = [...explicit, ...discovered.map((entry) => entry.path), ...remembered.map((entry) => entry.path), this.defaultPath(), join(homedir(), 'llama-swap', 'config.yaml'),
      '/opt/homebrew/etc/llama-swap/config.yaml', '/usr/local/etc/llama-swap/config.yaml',
      '/etc/llama-swap/config.yaml', '/etc/llama-swap/config/config.yaml'];
    const bindings = await Promise.all(discovered.filter((entry): entry is DiscoveredLlamaSwapConfig & { baseUrl: string } => entry.source === 'Running llama-swap' && !!entry.baseUrl).map(async (entry) => ({ path: await realpath(entry.path).catch(() => entry.path), baseUrl: entry.baseUrl })));
    const seen = new Set<string>(), configs: LocalLlamaSwapConfig[] = [];
    for (const candidate of candidates) {
      const path = await realpath(candidate).catch(() => candidate);
      if (seen.has(path)) continue;
      seen.add(path);
      const source = discovered.find((entry) => entry.path === candidate)?.source ?? (explicit.includes(candidate) ? (candidate === explicit[0] && this.externalConfigPath() ? 'Selected config' : 'Environment') : remembered.some((entry) => entry.path === candidate) ? 'Previously detected service' : 'Common location');
      const endpoints = [...new Set(bindings.filter((entry) => entry.path === path).map((entry) => entry.baseUrl))];
      try {
        const config = await readLlamaSwapDocument(path);
        const modelFiles: Record<string, string> = {};
        for (const name of config.models) {
          try {
            const file = modelCommandInfo(config.document, name).modelPath;
            if (file && isAbsolute(file) && !file.includes('${')) modelFiles[name] = await realpath(file).catch(() => file);
          } catch { /* Custom commands remain visible without guessing which file they use. */ }
        }
        configs.push({ path, owned: false, source, models: config.models, modelFiles,
          ...(endpoints.length === 1 ? { baseUrl: endpoints[0] } : {}) });
      }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && !explicit.includes(candidate) && !discovered.some((entry) => entry.path === candidate)) continue;
        const message = code === 'ENOENT' ? 'This config file no longer exists.' : code === 'EACCES' || code === 'EPERM' ? 'This config file is not readable.' : code ? 'Could not read this config file.' : error instanceof Error ? error.message : 'Could not read this config file.';
        configs.push({ path, owned: false, source, models: [], error: message });
      }
    }
    const candidatesAt = async (paths: string[]): Promise<string[]> => [...new Set(await Promise.all(paths.map((path) => realpath(path).catch(() => path))))];
    const explicitPaths = await candidatesAt(explicit);
    const activePaths = await candidatesAt(discovered.filter((entry) => entry.source === 'Running llama-swap').map((entry) => entry.path));
    const servicePaths = await candidatesAt(discovered.filter((entry) => entry.source === 'Service configuration').map((entry) => entry.path));
    const rememberedPaths = await candidatesAt(remembered.map((entry) => entry.path));
    const valid = (path: string): boolean => configs.some((entry) => entry.path === path && !entry.error);
    const choose = (paths: string[]): string | undefined => { const available = paths.filter(valid); return available.length === 1 ? available[0] : undefined; };
    // Prefer an explicit choice, then the running service, then a stopped/remembered service.
    const authoritative = (paths: string[]): string => choose(paths) ?? (paths.length === 1 ? paths[0] : '');
    this.target = explicitPaths.find(valid) ?? (activePaths.length ? authoritative(activePaths) : servicePaths.length ? authoritative(servicePaths) : choose(rememberedPaths) ?? choose(configs.map((entry) => entry.path)) ?? explicitPaths[0] ?? '');
    this.targetModels = configs.find((entry) => entry.path === this.target)?.models ?? [];
    return configs.map((entry) => ({ ...entry, selected: entry.path === this.target }));
  }

  async prepareTarget(): Promise<string> {
    const configs = await this.readConfigs();
    if (!this.target) throw new Error(configs.length > 1 ? 'Choose which llama-swap config to update in Engines. More than one config was found.' : 'Choose an existing llama-swap config in Engines before downloading.');
    const existing = configs.find((entry) => entry.path === this.target);
    if (existing?.error) throw new Error(existing.error);
    if (!existing) throw new Error('Choose an existing llama-swap config in Engines before downloading.');
    this.target = await realpath(this.target);
    await readLlamaSwapModels(this.target);
    return this.target;
  }

  modelName(model: InstalledLocalModel): string {
    return `${model.file.replace(/\.gguf$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 90) || 'model'}-${model.id.slice(0, 8)}`;
  }

  private async updateConfig(path: string, update: (models: YAMLMap, document: Document) => void, signal?: AbortSignal): Promise<void> {
    const source = await readLlamaSwapDocument(path);
    const document = source.document;
    if (!document.has('models')) document.set('models', document.createNode({}));
    const models = document.get('models', true);
    if (!isMap(models)) throw new Error('The models mapping must be written directly in the llama-swap config before it can be updated.');
    update(models, document);
    const next = document.toString();
    if (next === source.text) return;
    if (Buffer.byteLength(next) > 2_000_000) throw new Error('Adding this model would exceed the 2 MB llama-swap config limit.');
    await this.replaceConfig(path, source, next, signal);
  }

  private async replaceConfig(path: string, source: Awaited<ReturnType<typeof readLlamaSwapText>>, next: string, signal?: AbortSignal): Promise<void> {
    const temp = join(dirname(path), `.${randomUUID()}.llama-swap.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.chmod(source.info.mode & 0o777);
        const info = await file.stat();
        if (process.platform !== 'win32' && (info.uid !== source.info.uid || info.gid !== source.info.gid)) await file.chown(source.info.uid, source.info.gid);
        await file.writeFile(next);
        await file.sync();
      } finally { await file.close(); }
      if ((await readLlamaSwapText(path)).text !== source.text) throw new ConflictException('The llama-swap config changed since it was loaded. Reload it to keep those edits.');
      signal?.throwIfAborted();
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  }

  private async editablePath(input: string): Promise<string> {
    const configs = await this.readConfigs();
    const path = await realpath(input);
    if (!configs.some((entry) => entry.path === path)) throw new BadRequestException('Choose a detected llama-swap config before editing.');
    return path;
  }

  /** What keeps the selected config from running, and whether Repair can fix it without the editor. */
  async doctor(input?: string): Promise<LocalDoctor> {
    const configPath = input || this.status().engine.configPath;
    if (!configPath) return { configPath: '', issues: [{ kind: 'config-missing', detail: 'No llama-swap config was found. Start your existing service once, or install llama-swap here for first-time setup.', fixable: false }], fixable: false };
    const path = await realpath(configPath).catch(() => configPath);
    const issues: LocalDoctorIssue[] = [];
    if (!(await localExecutable('llama-swap'))) issues.push({ kind: 'tool-missing', detail: 'llama-swap is not installed. Set it up in Engines.', fixable: false });
    let version: string | undefined;
    try {
      const file = await readLlamaSwapText(path);
      version = createHash('sha256').update(file.text).digest('hex');
      const problem = checkLlamaSwapYaml(file.text);
      if (problem) issues.push({ kind: 'invalid-yaml', detail: `${problem.line ? `Line ${problem.line}: ` : ''}${problem.message} Fix it in Advanced YAML.`, fixable: false });
      else issues.push(...(await inspectModels(parseDocument(file.text), { llamaServer: await localExecutable('llama-server') })));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      issues.push({ kind: 'config-missing', detail: code === 'ENOENT' ? `The config ${path} no longer exists. Choose another in Engines.` : `The config ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`, fixable: false });
    }
    return { configPath: path, ...(version ? { version } : {}), issues, fixable: issues.some((issue) => issue.fixable) };
  }

  /** Applies the doctor's fixable findings to the file: entries without a file go, missing launchers are replaced; every other line stays. */
  async repair(input: LocalRepair): Promise<LocalDoctor> {
    const path = await this.editablePath(input.configPath);
    const file = await readLlamaSwapText(path);
    if (createHash('sha256').update(file.text).digest('hex') !== input.version) throw new ConflictException('The llama-swap config changed since it was checked. Check it again before repairing.');
    const document = parseDocument(file.text);
    if (document.errors.length) throw new BadRequestException('The config has invalid YAML. Fix it in Advanced YAML first.');
    const llamaServer = await localExecutable('llama-server');
    const changes = repairModels(document, await inspectModels(document, { llamaServer }), llamaServer);
    if (changes.length) await this.replaceConfig(path, file, document.toString());
    await this.readConfigs(true);
    return this.doctor(path);
  }

  async configFile(input: string): Promise<LocalConfigFile> {
    const path = await this.editablePath(input);
    const file = await readLlamaSwapText(path);
    return { path, text: file.text, mtime: file.info.mtimeMs, version: createHash('sha256').update(file.text).digest('hex') };
  }

  async saveConfigFile(input: { path: string; text: string; version: string }): Promise<LocalConfigFile> {
    const path = await this.editablePath(input.path);
    const problem = checkLlamaSwapYaml(input.text);
    if (problem) throw new BadRequestException(`${problem.line ? `Line ${problem.line}: ` : ''}${problem.message}`);
    const file = await readLlamaSwapText(path);
    if (createHash('sha256').update(file.text).digest('hex') !== input.version) throw new ConflictException('The llama-swap config changed since it was loaded. Reload it before saving.');
    await this.replaceConfig(path, file, input.text);
    await this.readConfigs();
    return this.configFile(path);
  }

  async modelOptions(path: string, model: string): Promise<LocalModelOptions> {
    const file = await this.configFile(path);
    const problem = checkLlamaSwapYaml(file.text);
    if (problem) throw new BadRequestException('Fix the config in Advanced YAML before configuring a model.');
    try {
      const document = parseDocument(file.text), target = await this.reloadTarget(file.path);
      const level = document.get('logLevel');
      const logging = document.get('logToStdout');
      const proxyLoggingOff = logging === false || (typeof logging === 'string' && logging !== 'both' && !logging.split(',').map((part) => part.trim()).includes('proxy'));
      const reason = process.platform === 'win32' ? 'Immediate reload of an existing process is supported on macOS and Linux.' : !target ? 'Start the existing llama-swap service for this config to reload a model here.' : proxyLoggingOff || ['warn', 'error'].includes(String(level)) ? 'Enable llama-swap proxy logging at info or debug to verify immediate reloads.' : model.split('/').some((part) => !part || part === '.' || part === '..') ? 'This model ID cannot be addressed by the reload API.' : undefined;
      const basic = readModelOptions(document, model);
      const mtp = basic.engine === 'llama.cpp' ? await detectModelMtp(document, model) : undefined;
      return { path: file.path, model, version: file.version, ...readModelOptions(document, model, mtp?.status === 'detected'), ...(mtp ? { mtp } : {}), reload: { available: !reason, ...(reason ? { reason } : {}), ...(target?.baseUrl ? { baseUrl: target.baseUrl } : {}) } };
    }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Could not read model options.'); }
  }

  private async reloadTarget(path: string, force = false): Promise<DiscoveredLlamaSwapConfig | undefined> {
    await this.readConfigs(force);
    const candidates = [];
    for (const entry of this.discovery?.paths ?? []) {
      if (entry.source === 'Running llama-swap' && entry.pid && entry.pid > 1 && entry.baseUrl && await realpath(entry.path).catch(() => '') === path) candidates.push(entry);
    }
    const unique = [...new Map(candidates.map((entry) => [entry.pid, entry])).values()];
    return unique.length === 1 ? unique[0] : undefined;
  }

  async reloadModel(input: LocalModelReload, signal: AbortSignal, progress: (detail: string) => void): Promise<void> {
    const target = await this.reloadTarget(await realpath(input.path), true);
    const options = await this.modelOptions(input.path, input.model);
    if (options.version !== input.version) throw new ConflictException('The config changed since saving. Reload model settings before applying it.');
    if (!options.reload?.available || !target?.pid || !target.baseUrl) throw new BadRequestException(options.reload?.reason ?? 'No running llama-swap instance was detected for this config.');
    const file = await this.configFile(input.path), document = parseDocument(file.text);
    const configuredKey = document.getIn(['apiKeys', 0]);
    const key = typeof configuredKey === 'string' ? configuredKey.replace(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_original, name: string) => process.env[name] ?? '') : '';
    if (configuredKey && (!key || key.includes('${'))) throw new BadRequestException('The existing llama-swap API key cannot be resolved in this app. Saved settings are retained.');
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
    const pid = target.pid;
    const timeout = Number(document.get('healthCheckTimeout'));
    const verify = async (): Promise<void> => {
      signal.throwIfAborted();
      if ((await this.configFile(input.path)).version !== input.version) throw new ConflictException('The config changed during reload. Reload model settings to review the current values.');
      const current = await this.reloadTarget(file.path, true);
      if (current?.pid !== target.pid || current?.baseUrl !== target.baseUrl) throw new ConflictException('The existing llama-swap process changed. Retry reload to detect it again.');
    };
    await reloadExistingModel({ baseUrl: target.baseUrl, model: input.model, headers, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 1800) * 1000 : 120_000, watching: !!target.watching, signal, progress, verify,
      signalReload: async () => { await verify(); process.kill(pid, 'SIGHUP'); },
    });
  }

  async saveModelOptions(input: LocalModelOptionsSave): Promise<LocalModelOptions> {
    const parsed = LocalModelOptionsSaveSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('One or more model options are invalid.');
    const file = await this.configFile(input.path);
    if (file.version !== input.version) throw new ConflictException('The config changed since this form was opened. Reload model settings before saving.');
    const document = parseDocument(file.text);
    if (checkLlamaSwapYaml(file.text)) throw new BadRequestException('Fix the config in Advanced YAML before configuring a model.');
    try {
      const basic = readModelOptions(document, input.model);
      const mtp = basic.engine === 'llama.cpp' ? await detectModelMtp(document, input.model) : undefined;
      if (parsed.data.values.specType?.split(',').includes('draft-mtp') && !['detected', 'configured'].includes(mtp?.status ?? '')) throw new Error('MTP support could not be verified for this model and engine.');
      patchModelOptions(document, input.model, parsed.data.values, mtp?.status === 'detected');
    }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Could not update model options.'); }
    await this.saveConfigFile({ path: file.path, version: file.version, text: document.toString() });
    return this.modelOptions(file.path, input.model);
  }

  private async addModels(path: string, models: InstalledLocalModel[], signal?: AbortSignal): Promise<void> {
    const llama = await localExecutable('llama-server') ?? 'llama-server';
    const added: Registration[] = [];
    await this.updateConfig(path, (entries, document) => {
      for (const model of models) {
        const previous = this.registrations.find((entry) => entry.configPath === path && entry.model.id === model.id);
        const base = this.modelName(model);
        let name = previous?.name ?? base;
        let suffix = 2;
        // A user may have repurposed even a previously registered entry. Preserve it and choose a free name.
        while (entries.has(name) && !refersToModel(document.getIn(['models', name, 'cmd']), model.path)) name = `${base}-${suffix++}`;
        if (!entries.has(name)) entries.set(name, document.createNode({ cmd: `${quote(llama)} --model ${quote(model.path)} --host 127.0.0.1 --port \${PORT} --jinja` }));
        added.push({ configPath: path, name, model });
      }
    }, signal);
    this.registrations = [...this.registrations.filter((entry) => !added.some((add) => add.configPath === entry.configPath && add.model.id === entry.model.id)), ...added];
    this.meta.setSetting('local-runtime-config-models', this.registrations);
    this.meta.setSetting('local-runtime-models', []);
    this.targetModels = await readLlamaSwapModels(path);
  }

  async register(model: InstalledLocalModel, signal?: AbortSignal, targetPath?: string): Promise<void> {
    signal?.throwIfAborted();
    const path = targetPath ? await realpath(targetPath) : await this.prepareTarget();
    await this.addModels(path, [...(await this.previousDownloads(path)).filter((entry) => entry.id !== model.id), model], signal);
  }

  async unregister(id: string): Promise<void> {
    for (const entry of this.registrations.filter((registration) => registration.model.id === id)) {
      try {
        await this.updateConfig(entry.configPath, (models, document) => {
          const cmd = document.getIn(['models', entry.name, 'cmd']);
          if (refersToModel(cmd, entry.model.path)) models.delete(entry.name);
        });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.registrations = this.registrations.filter((entry) => entry.model.id !== id);
    this.meta.setSetting('local-runtime-config-models', this.registrations);
    // A deleted legacy download must not be re-added during a later config selection.
    const previous = InstalledLocalModelSchema.array().safeParse(this.meta.getSetting('local-runtime-models'));
    if (previous.success) this.meta.setSetting('local-runtime-models', previous.data.filter((model) => model.id !== id));
    await this.readConfigs();
  }

  async refreshTools(firstInstall = false): Promise<void> {
    const configs = await this.readConfigs();
    if (firstInstall && configs.length === 0) {
      const path = this.defaultPath();
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; return undefined; });
      if (file) { try { await file.writeFile('models: {}\n'); } finally { await file.close(); } }
      await this.readConfigs();
    }
    if (!this.target) return;
    const llama = await localExecutable('llama-server');
    if (!llama) return;
    const known = this.registrations.filter((entry) => entry.configPath === this.target);
    if (!known.length) return;
    await this.updateConfig(this.target, (_models, document) => {
      for (const entry of known) {
        const cmd = document.getIn(['models', entry.name, 'cmd']);
        if (typeof cmd === 'string' && cmd.startsWith(`${quote('llama-server')} `)) document.setIn(['models', entry.name, 'cmd'], `${quote(llama)}${cmd.slice(quote('llama-server').length)}`);
      }
    });
  }

  status(): { engine: { configPath: string; modelIds: string[] } } {
    return { engine: { configPath: this.target, modelIds: this.registrations.filter((entry) => entry.configPath === this.target && this.targetModels.includes(entry.name)).map((entry) => entry.model.id) } };
  }
}
