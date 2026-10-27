import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MCP_EXPOSURES, type McpExposure } from '@pi-kit/protocol';

/**
 * Reading and changing pi's MCP configuration (`~/.pi/agent/mcp.json`, `<project>/.pi/mcp.json`; docs/mcp.md).
 *
 * pi owns the format and loads it itself when a session starts; this module only lists what is configured, so the
 * panel can show a server before (or without) a session and can tell where each entry comes from, and flips
 * `enabled` the way pi's own `/mcp` manager does (`enabled: true` is the default and removes the key). The
 * validation is as lenient as the panel needs: pi remains the judge of what connects, and what it rejects it
 * reports (`config: ...`), which the panel shows next to our own file errors.
 */

export interface McpConfigEntry {
  name: string;
  scope: 'global' | 'project';
  /** The file that defines the server. */
  source: string;
  /** The project file overriding `enabled` / `exposure` of a global server. */
  override?: string;
  transport: 'stdio' | 'http';
  target: string;
  description?: string;
  exposure: McpExposure;
  enabled: boolean;
  /** HTTP server without an `Authorization` header and without `auth`: signs in with OAuth. */
  oauth: boolean;
}

export interface McpConfigRead {
  servers: McpConfigEntry[];
  errors: string[];
  userConfig: string;
  /** The project file, when the project is trusted (it need not exist). */
  projectConfig?: string;
}

const NAME = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function userMcpConfigPath(agentDir: string): string {
  return join(agentDir, 'mcp.json');
}

export function projectMcpConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'mcp.json');
}

function readServers(path: string, errors: string[]): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) throw new Error('the file is not a JSON object');
    const servers = parsed['mcpServers'];
    if (servers === undefined) return {};
    if (!isRecord(servers)) throw new Error('"mcpServers" is not an object');
    return servers;
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function exposureOf(value: unknown, fallback: McpExposure = 'codemode'): McpExposure {
  if (value === 'codemode-deferred') return 'codemode';
  return (MCP_EXPOSURES as readonly unknown[]).includes(value) ? (value as McpExposure) : fallback;
}

function describeEntry(name: string, raw: Record<string, unknown>, scope: 'global' | 'project', source: string): McpConfigEntry | string {
  if (!NAME.test(name)) return `${source}: server name "${name}" may contain only letters, digits, "_" and "-".`;
  const url = typeof raw['url'] === 'string' ? raw['url'] : undefined;
  const command = typeof raw['command'] === 'string' ? raw['command'] : undefined;
  if (!url && !command) return `${source}: server "${name}" needs a "command" or a "url".`;
  const args = Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : [];
  const headers = isRecord(raw['headers']) ? Object.keys(raw['headers']) : [];
  const hasAuthorization = headers.some((h) => h.toLowerCase() === 'authorization');
  return {
    name,
    scope,
    source,
    transport: url ? 'http' : 'stdio',
    target: url ?? [command, ...args].join(' '),
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
    exposure: exposureOf(raw['exposure']),
    enabled: raw['enabled'] !== false,
    oauth: !!url && !hasAuthorization && raw['auth'] === undefined,
  };
}

/** A project entry with neither `command`, `url` nor `type` overrides only `enabled` and `exposure` of the global server. */
const isOverrideOnly = (raw: Record<string, unknown>): boolean => raw['command'] === undefined && raw['url'] === undefined && raw['type'] === undefined;

export function readMcpConfig(options: { agentDir: string; cwd?: string; projectTrusted: boolean }): McpConfigRead {
  const errors: string[] = [];
  const userConfig = userMcpConfigPath(options.agentDir);
  const byName = new Map<string, McpConfigEntry>();

  for (const [name, raw] of Object.entries(readServers(userConfig, errors))) {
    if (!isRecord(raw)) {
      errors.push(`${userConfig}: server "${name}" is not an object.`);
      continue;
    }
    const entry = describeEntry(name, raw, 'global', userConfig);
    if (typeof entry === 'string') errors.push(entry);
    else byName.set(name, entry);
  }

  let projectConfig: string | undefined;
  if (options.cwd && options.projectTrusted) {
    projectConfig = projectMcpConfigPath(options.cwd);
    for (const [name, raw] of Object.entries(readServers(projectConfig, errors))) {
      if (!isRecord(raw)) {
        errors.push(`${projectConfig}: server "${name}" is not an object.`);
        continue;
      }
      const global = byName.get(name);
      if (isOverrideOnly(raw) && global) {
        byName.set(name, {
          ...global,
          override: projectConfig,
          ...(raw['enabled'] !== undefined ? { enabled: raw['enabled'] !== false } : {}),
          ...(raw['exposure'] !== undefined ? { exposure: exposureOf(raw['exposure'], global.exposure) } : {}),
        });
        continue;
      }
      const entry = describeEntry(name, raw, 'project', projectConfig);
      if (typeof entry === 'string') errors.push(entry);
      else byName.set(name, entry);
    }
  }
  return { servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors, userConfig, ...(projectConfig ? { projectConfig } : {}) };
}

/** `enabled` for one server in the file that defines it (or its project override), keeping the rest of the file as it is. */
export function setMcpServerEnabled(entry: Pick<McpConfigEntry, 'name' | 'source' | 'override'>, enabled: boolean): string {
  const path = entry.override ?? entry.source;
  const text = readFileSync(path, 'utf8');
  const root: unknown = JSON.parse(text);
  if (!isRecord(root) || !isRecord(root['mcpServers'])) throw new Error(`${path} has no "mcpServers" object.`);
  const server = root['mcpServers'][entry.name];
  if (!isRecord(server)) throw new Error(`${path} does not define "${entry.name}".`);
  // pi keeps defaults out of the file: `enabled: true` removes the key. An override entry is kept even when empty.
  if (enabled) delete server['enabled'];
  else server['enabled'] = false;
  writeFileSync(path, `${JSON.stringify(root, null, indentOf(text))}\n`);
  return path;
}

/** The indentation a JSON file uses (two spaces if it cannot tell). */
export function indentOf(text: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(text);
  return match ? match[0] : 2;
}

// ---- writing (connectors)

/** What a file holds before a change: the parsed object and the indentation to keep, or an empty object for a file that is not there. A file that is not a JSON object is never overwritten. */
function loadForWrite(path: string): { root: Record<string, unknown>; indent: string | number } {
  if (!existsSync(path)) return { root: {}, indent: 2 };
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return { root: {}, indent: 2 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}, { cause: error }); fix it first, pi-kit will not overwrite it.`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object; fix it first, pi-kit will not overwrite it.`);
  if (parsed['mcpServers'] !== undefined && !isRecord(parsed['mcpServers'])) throw new Error(`"mcpServers" in ${path} is not an object; fix it first, pi-kit will not overwrite it.`);
  return { root: parsed, indent: indentOf(text) };
}

/** User files can contain direct credentials; only existing project .pi/mcp.json keeps shareable permissions. */
function configWriteMode(path: string): number {
  return basename(dirname(path)) === '.pi' && existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
}

function writeAtomically(path: string, root: Record<string, unknown>, indent: string | number): void {
  const mode = configWriteMode(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(root, null, indent)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/**
 * Adds or replaces `mcpServers[name]` in a configuration file and leaves everything else in it as it was: other servers, top-level keys such as `autoEnableCodemode`, and the
 * file's indentation. Returns whether an entry of that name was replaced.
 */
export function writeMcpServer(path: string, name: string, config: Record<string, unknown>): boolean {
  if (!NAME.test(name)) throw new Error(`Server name "${name}" may contain only letters, digits, "_" and "-".`);
  const { root, indent } = loadForWrite(path);
  const servers = isRecord(root['mcpServers']) ? root['mcpServers'] : {};
  const replaced = name in servers;
  root['mcpServers'] = { ...servers, [name]: config };
  writeAtomically(path, root, indent);
  return replaced;
}

/** Removes `mcpServers[name]` and nothing else; false when the file or the entry was not there (the file is not touched then). */
export function removeMcpServer(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  const { root, indent } = loadForWrite(path);
  const servers = root['mcpServers'];
  if (!isRecord(servers) || !(name in servers)) return false;
  const rest = { ...servers };
  delete rest[name];
  root['mcpServers'] = rest;
  writeAtomically(path, root, indent);
  return true;
}

/** `exposure` for one server in the file that defines it (or its project override). `codemode`, pi's default, removes the key as pi's own manager does. */
export function setMcpServerExposure(entry: Pick<McpConfigEntry, 'name' | 'source' | 'override'>, exposure: McpExposure): string {
  const path = entry.override ?? entry.source;
  const { root, indent } = loadForWrite(path);
  const servers = root['mcpServers'];
  const server = isRecord(servers) ? servers[entry.name] : undefined;
  if (!isRecord(server)) throw new Error(`${path} does not define "${entry.name}".`);
  if (exposure === 'codemode') delete server['exposure'];
  else server['exposure'] = exposure;
  writeAtomically(path, root, indent);
  return path;
}

// ---- editing

/** One entry of a configuration file as the file has it, or undefined when the file, the `mcpServers` object or the entry is not there (or the file cannot be read). */
export function readMcpEntry(path: string, name: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const servers = isRecord(parsed) ? parsed['mcpServers'] : undefined;
    const entry = isRecord(servers) ? servers[name] : undefined;
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** The modified time of a file in ms, or 0 for a file that is not there: the editor's token for "nobody changed it since". */
export function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Writes beside the file and renames over it. User configuration is always private; existing project files retain their permissions. */
export function writeTextAtomically(path: string, text: string): void {
  const mode = configWriteMode(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}
