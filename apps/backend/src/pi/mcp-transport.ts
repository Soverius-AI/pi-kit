import { exec } from 'node:child_process';
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
 * - values of `env` and `headers` may contain `${NAME}`, or be `!command` as a whole. A command runs when the server
 *   starts, within the server's `timeout` (default 60 s), and stops when the transport closes.
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
    timeout?: number;
  };
}

export interface CommandOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

export interface TransportClasses<T> {
  StdioTransport: new (options: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stderr?: 'pipe' | 'inherit';
  }) => T;
  StreamableHttpTransport: new (options: {
    url: string;
    headers?: Record<string, string>;
    authProvider?: unknown;
  }) => T;
}

export function expandHome(value: string, home = homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\')))
    return join(home, value.slice(2));
  return value;
}

/** `${NAME}` becomes the variable; a value that starts with `!` is a command whose output is the value. */
export function resolveConfigValue(
  value: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  run?: (command: string) => string,
): string {
  if (value.startsWith('!')) {
    if (!run) throw new Error(`${label}: the command ${value.slice(1)} runs only when the MCP server starts.`);
    try {
      return run(value.slice(1)).trim();
    } catch (error) {
      throw new Error(
        `${label}: the command ${value.slice(1)} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`${label}: the environment variable ${name} is not set.`);
    return found;
  });
}

function resolveAll(values: Record<string, string> | undefined, label: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [key, resolveConfigValue(value, `${label} "${key}"`)]),
  );
}

export function createMcpTransport<T>(
  classes: TransportClasses<T>,
  entry: McpEntryLike,
  cwd: string,
  authProvider: unknown,
  run: (command: string, options: CommandOptions) => Promise<string> = DeferredTransport.run,
): T {
  const { config, name } = entry;
  const values = config.url ? config.headers : config.env;
  const label = config.url ? `MCP server "${name}" header` : `MCP server "${name}" env`;
  const build = (resolved: Record<string, string>): T =>
    config.url
      ? new classes.StreamableHttpTransport({ url: config.url, headers: resolved, authProvider })
      : new classes.StdioTransport({
          command: expandHome(config.command ?? ''),
          args: config.args?.map((arg) => expandHome(arg)),
          cwd: resolve(cwd, expandHome(config.cwd ?? '.')),
          env: resolved,
          stderr: 'pipe',
        });
  if (!Object.values(values ?? {}).some((value) => value.startsWith('!'))) return build(resolveAll(values, label));
  const timeoutMs = (config.timeout ?? DeferredTransport.defaultTimeoutSeconds) * 1000;
  return new DeferredTransport(
    async (signal) =>
      build(
        await DeferredTransport.resolve(values, label, (command) => run(command, { timeoutMs, signal })),
      ) as unknown as DeferrableTransport,
  ) as unknown as T;
}

export interface DeferrableTransport {
  start(): Promise<void>;
  send(message: never, options?: never): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: never) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
  setProtocolVersion?(version: string): void;
}

export class DeferredTransport implements DeferrableTransport {
  private real: DeferrableTransport | undefined;
  private readonly messages = new Set<(message: never) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly closes = new Set<() => void>();
  private version: string | undefined;
  private closed = false;
  private closeEmitted = false;
  private readonly stopping = new AbortController();

  static readonly defaultTimeoutSeconds = 60;

  constructor(private readonly build: (signal: AbortSignal) => Promise<DeferrableTransport>) {}

  static run(command: string, { timeoutMs, signal }: CommandOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = exec(
        command,
        { encoding: 'utf8', timeout: timeoutMs, signal, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end();
    });
  }

  static async resolve(
    values: Record<string, string> | undefined,
    label: string,
    run: (command: string) => Promise<string>,
  ): Promise<Record<string, string>> {
    const entries = await Promise.all(
      Object.entries(values ?? {}).map(async ([key, value]): Promise<[string, string]> => {
        const where = `${label} "${key}"`;
        if (!value.startsWith('!')) return [key, resolveConfigValue(value, where)];
        try {
          return [key, (await run(value.slice(1))).trim()];
        } catch (error) {
          throw new Error(
            `${where}: the command ${value.slice(1)} failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async start(): Promise<void> {
    const real = await this.build(this.stopping.signal).catch((error: unknown) => {
      if (!this.closed) throw error;
    });
    if (!real || this.closed) throw new Error('The MCP transport was closed before it started.');
    this.real = real;
    real.onMessage((message) => {
      for (const listener of [...this.messages]) listener(message);
    });
    real.onError((error) => {
      for (const listener of [...this.errors]) listener(error);
    });
    real.onClose(() => this.emitClose());
    if (this.version !== undefined) real.setProtocolVersion?.(this.version);
    await real.start();
  }

  send(message: never, options?: never): Promise<void> {
    return this.real
      ? this.real.send(message, options)
      : Promise.reject(new Error('The MCP transport has not started.'));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    if (this.real) await this.real.close();
    else this.emitClose();
  }

  onMessage(listener: (message: never) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  setProtocolVersion(version: string): void {
    this.version = version;
    this.real?.setProtocolVersion?.(version);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of [...this.closes]) listener();
  }
}
