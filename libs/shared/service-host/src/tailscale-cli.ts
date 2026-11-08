import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RemoteAccessProcess } from './remote-access';

type RecordValue = Record<string, unknown>;

/** Only predefined command facts may cross the renderer boundary. */
export class RemoteAccessCommandError extends Error {
  readonly diagnostic: string;
  constructor(
    readonly kind: 'timeout' | 'permission' | 'unavailable' | 'failed',
    code?: number,
  ) {
    super('Tailscale command ' + kind);
    this.diagnostic = `command-${kind}${typeof code === 'number' && Number.isInteger(code) && Math.abs(code) <= 255 ? ` (exit ${code})` : ''}`;
  }

  /** Output is inspected privately, never copied into diagnostics or messages. */
  static from(
    error: { code?: string | number | null; killed?: boolean; signal?: string | null },
    stderr = '',
  ): RemoteAccessCommandError {
    const kind =
      error.killed || error.code === 'ETIMEDOUT'
        ? 'timeout'
        : error.code === 'EACCES' ||
            error.code === 'EPERM' ||
            /permission denied|access denied|not permitted/i.test(stderr)
          ? 'permission'
          : error.code === 'ENOENT' || /failed to connect|daemon.*not running|not connected/i.test(stderr)
            ? 'unavailable'
            : 'failed';
    return new RemoteAccessCommandError(kind, typeof error.code === 'number' ? error.code : undefined);
  }
}

export class StatusDataError extends Error {
  constructor(
    readonly step: 'status' | 'serve-status',
    readonly reason = 'invalid-json',
  ) {
    super('Invalid Tailscale JSON');
  }
}

/** The installed Tailscale CLI: discovery, bounded commands and the foreground Serve process, always in CLI mode. */
export class TailscaleCli {
  /**
   * Tailscale's bundled executable recognizes TAILSCALE_BE_CLI=1. Without it, Finder-style environments lacking SHLVL
   * can select GUI mode instead: the installed 1.104.5 binary returned a GUI-start failure on stdout with exit 0.
   */
  static environment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...env, TAILSCALE_BE_CLI: '1' };
  }

  async findCli(): Promise<string | undefined> {
    const windows = process.platform === 'win32';
    const candidates = windows
      ? [process.env['ProgramFiles'], process.env['ProgramW6432'], process.env['ProgramFiles(x86)']]
          .filter((p): p is string => !!p && isAbsolute(p))
          .map((p) => join(p, 'Tailscale', 'tailscale.exe'))
      : [
          '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
          '/usr/bin/tailscale',
          '/usr/local/bin/tailscale',
          '/opt/homebrew/bin/tailscale',
        ];
    for (const directory of (process.env['PATH'] ?? '').split(windows ? ';' : ':')) {
      // Never search cwd, relative PATH entries, shell scripts or .cmd/.bat wrappers.
      if (isAbsolute(directory)) candidates.push(join(directory, windows ? 'tailscale.exe' : 'tailscale'));
    }
    for (const candidate of [...new Set(candidates)]) {
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* try next known location */
      }
    }
    return undefined;
  }

  run(file: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          shell: false,
          windowsHide: true,
          timeout: 8000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          env: TailscaleCli.environment(),
        },
        (error, stdout, stderr) => {
          if (error) reject(RemoteAccessCommandError.from(error, stderr));
          else resolve(stdout);
        },
      );
    });
  }

  launch(file: string, args: readonly string[]): RemoteAccessProcess {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: TailscaleCli.environment(),
    });
    let output = Buffer.alloc(0);
    const capture = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]).subarray(-8192);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const exited = new Promise<void>((resolve) => child.once('error', () => resolve()).once('exit', () => resolve()));
    return { exited, output: () => output.toString('utf8'), kill: (signal) => child.kill(signal) };
  }
}

abstract class TailscaleDocument {
  protected static object(value: unknown): RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
  }

  protected static read(output: string, step: 'status' | 'serve-status'): RecordValue {
    if (output.includes('The Tailscale GUI failed to start')) throw new StatusDataError(step, 'cli-mode');
    try {
      const parsed: unknown = JSON.parse(output);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      if (step === 'status' && typeof (parsed as RecordValue)['BackendState'] !== 'string') throw new Error();
      return parsed as RecordValue;
    } catch {
      throw new StatusDataError(step);
    }
  }
}

/** `tailscale status --json`, reduced to the facts remote access acts on. */
export class TailscaleStatus extends TailscaleDocument {
  private constructor(private readonly raw: RecordValue) {
    super();
  }

  static parse(output: string): TailscaleStatus {
    return new TailscaleStatus(TailscaleDocument.read(output, 'status'));
  }

  static dnsName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const name = value.replace(/\.$/, '').toLowerCase();
    if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(name)) return undefined;
    return name;
  }

  get running(): boolean {
    return this.raw['BackendState'] === 'Running';
  }

  get needsLogin(): boolean {
    return this.raw['BackendState'] === 'NeedsLogin';
  }

  get version(): string | undefined {
    const value = this.raw['Version'];
    return typeof value === 'string' && value.length <= 80 && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(value)
      ? value
      : undefined;
  }

  get dnsName(): string | undefined {
    return TailscaleStatus.dnsName(TailscaleDocument.object(this.raw['Self'])['DNSName']);
  }

  get reportsCertificates(): boolean {
    return 'CertDomains' in this.raw;
  }

  /** Undefined until the CLI lists certificate domains at all. */
  get httpsReady(): boolean | undefined {
    const domains = this.raw['CertDomains'];
    if (!Array.isArray(domains)) return undefined;
    const dns = this.dnsName;
    return !!dns && domains.some((value: unknown) => TailscaleStatus.dnsName(value) === dns);
  }
}

/** `tailscale serve status --json`, persistent and foreground sessions alike. Unknown occupied shapes are conflicts, never an invitation to overwrite them. */
export class ServeConfig extends TailscaleDocument {
  constructor(private readonly raw: unknown) {
    super();
  }

  static parse(output: string): ServeConfig {
    return new ServeConfig(TailscaleDocument.read(output, 'serve-status'));
  }

  listeners(port: number): RecordValue[] {
    const result: RecordValue[] = [];
    const portKey = (key: string) => key === String(port) || key.endsWith(`:${port}`);
    const visit = (scope: RecordValue) => {
      if (
        Object.keys(TailscaleDocument.object(scope['TCP'])).some(portKey) ||
        Object.keys(TailscaleDocument.object(scope['Web'])).some(portKey) ||
        Object.keys(TailscaleDocument.object(scope['AllowFunnel'])).some(portKey)
      )
        result.push(scope);
      for (const child of Object.values(TailscaleDocument.object(scope['Foreground'])))
        visit(TailscaleDocument.object(child));
    };
    visit(TailscaleDocument.object(this.raw));
    return result;
  }

  owned(dns: string, target: string, port: number): boolean {
    const matches = this.listeners(port);
    if (matches.length !== 1) return false;
    const scope = matches[0];
    const tcp = TailscaleDocument.object(TailscaleDocument.object(scope['TCP'])[String(port)]);
    if (tcp['HTTPS'] !== true || tcp['HTTP'] || tcp['TCPForward'] || tcp['TerminateTLS']) return false;
    if (
      Object.entries(TailscaleDocument.object(scope['AllowFunnel'])).some(
        ([key, value]) => key.endsWith(`:${port}`) && value !== false,
      )
    )
      return false;
    const web = TailscaleDocument.object(scope['Web']);
    const keys = Object.keys(web).filter((key) => key.endsWith(`:${port}`));
    if (keys.length !== 1 || keys[0] !== `${dns}:${port}`) return false;
    const handlers = TailscaleDocument.object(TailscaleDocument.object(web[keys[0]])['Handlers']);
    const handler = TailscaleDocument.object(handlers['/']);
    return Object.keys(handlers).length === 1 && Object.keys(handler).length === 1 && handler['Proxy'] === target;
  }
}
