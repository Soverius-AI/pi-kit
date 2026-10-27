import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The transports pi's MCP extension builds for a configured server (`createDefaultTransport` in its runtime),
 * rebuilt here because `PiSessionService` has to wrap them with the tap and the extension only
 * accepts a replacement for the whole factory. The behaviour follows docs/mcp.md of pi 1.2.0:
 *
 * - stdio: `command` is one executable with `args`; `cwd` is relative to the session's folder; `~/` names the
 *   home directory in the command, the arguments and `cwd`;
 * - HTTP: `url` and `headers`, with the auth provider pi made for the server (OAuth tokens, a provider's token);
 * - values of `env` and `headers` may contain `${NAME}`, or be `!command` as a whole.
 *
 * The transport classes are passed in (they come from `@earendil-works/pi-mcp`, loaded by `PiSessionService`), so
 * this file imports nothing from pi.
 */

/** The shapes of the entry pi hands to a transport factory (`McpServerEntry`). */
export interface McpEntryLike {
  name: string;
  config: {
    url?: string;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
}

export interface TransportClasses<T> {
  StdioTransport: new (options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stderr?: 'pipe' | 'inherit' }) => T;
  StreamableHttpTransport: new (options: { url: string; headers?: Record<string, string>; authProvider?: unknown }) => T;
}

export function expandHome(value: string, home = homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) return join(home, value.slice(2));
  return value;
}

/** `${NAME}` becomes the variable; a value that starts with `!` is a command whose output is the value. */
export function resolveConfigValue(value: string, label: string, env: NodeJS.ProcessEnv = process.env, run: (command: string) => string = runCommand): string {
  if (value.startsWith('!')) {
    try {
      return run(value.slice(1)).trim();
    } catch (error) {
      throw new Error(`${label}: the command ${value.slice(1)} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`${label}: the environment variable ${name} is not set.`);
    return found;
  });
}

function runCommand(command: string): string {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
}

function resolveAll(values: Record<string, string> | undefined, label: string): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, resolveConfigValue(value, `${label} "${key}"`)]));
}

export function createMcpTransport<T>(classes: TransportClasses<T>, entry: McpEntryLike, cwd: string, authProvider: unknown): T {
  const { config, name } = entry;
  if (config.url) {
    return new classes.StreamableHttpTransport({
      url: config.url,
      headers: resolveAll(config.headers, `MCP server "${name}" header`),
      authProvider,
    });
  }
  return new classes.StdioTransport({
    command: expandHome(config.command ?? ''),
    args: config.args?.map((arg) => expandHome(arg)),
    cwd: resolve(cwd, expandHome(config.cwd ?? '.')),
    env: resolveAll(config.env, `MCP server "${name}" env`),
    stderr: 'pipe',
  });
}
