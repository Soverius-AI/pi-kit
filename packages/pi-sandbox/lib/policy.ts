import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxOptions } from './core.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SandboxError } from './protocol.js';

export class SandboxPolicy {
  private static readonly GLOB = /[\r\n*?[\]{}]/;
  private static readonly ENV = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM'];
  private static readonly CREDENTIALS = [
    '.ssh',
    '.aws',
    '.azure',
    '.config',
    '.pi',
    '.npmrc',
    '.netrc',
    '.git-credentials',
    '.gnupg',
    'Library',
  ];

  static validate(value: unknown): asserts value is SandboxOptions {
    const options = Object(value) as Record<string, unknown>;
    if (!value || !SandboxPolicy.isLiteralPath(options.cwd))
      throw new SandboxError('cwd must be an absolute local path without glob characters', 'INVALID_ARGUMENT');
    SandboxPolicy.assertWorkspace(options.cwd);
    if (process.platform === 'win32' && (!options.experimentalWindowsAccepted || /^\\\\/.test(options.cwd)))
      throw new SandboxError(
        'Windows requires explicit experimental acceptance and a local workspace',
        'WINDOWS_EXPERIMENTAL_REQUIRED',
      );
    const protectedPaths = options.protectedPaths;
    if (
      protectedPaths !== undefined &&
      (!Array.isArray(protectedPaths) ||
        protectedPaths.length > 256 ||
        !protectedPaths.every((p) => SandboxPolicy.isLiteralPath(p)) ||
        protectedPaths.reduce((n: number, p: string) => n + Buffer.byteLength(p), 0) > 65536)
    )
      throw new SandboxError(
        'protectedPaths must contain at most 256 absolute literal paths (64 KiB in total)',
        'INVALID_ARGUMENT',
      );
  }

  /** Rejects filesystem roots and any directory that contains the user's home: those grants are not project scoped. */
  static assertWorkspace(cwd: string): void {
    const resolved = path.resolve(cwd);
    if (resolved === path.parse(resolved).root)
      throw new SandboxError('Filesystem roots are not project workspaces', 'INVALID_ARGUMENT');
    if (SandboxPolicy.contains(resolved, os.homedir()))
      throw new SandboxError(
        'The home directory and its ancestors are not project workspaces; choose a project folder',
        'INVALID_ARGUMENT',
      );
  }

  static contains(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
      relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  }

  static pickEnv(source: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of SandboxPolicy.ENV) {
      const value = source[key];
      if (typeof value === 'string' && value.length < 1024) env[key] = value;
    }
    return env;
  }

  static cleanEnv(
    source: NodeJS.ProcessEnv = {},
    { temp, cwd }: { temp?: string; cwd?: string } = {},
  ): NodeJS.ProcessEnv {
    const env = SandboxPolicy.pickEnv(source);
    env.PATH =
      process.platform === 'win32'
        ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${path.dirname(process.execPath)}`
        : `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:${path.dirname(process.execPath)}`;
    if (process.platform === 'win32') {
      env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
      env.WINDIR = env.SystemRoot;
    }
    if (temp) {
      env.TMPDIR = temp;
      env.TMP = temp;
      env.TEMP = temp;
      env.HOME = temp;
      env.USERPROFILE = temp;
    }
    if (cwd) env.PWD = cwd;
    // Electron's executable doubles as the Node runtime for the helpers; never forward the caller's value.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
  }

  static compile(
    { cwd, protectedPaths = [] }: Pick<SandboxOptions, 'cwd' | 'protectedPaths'>,
    temp: string,
    helpers: { seccomp?: string; srtWin?: string; javaAgent?: string },
  ): SandboxRuntimeConfig {
    const lib = path.dirname(fileURLToPath(import.meta.url));
    const home = os.homedir();
    const node = path.dirname(process.execPath);
    const credentials = [...SandboxPolicy.CREDENTIALS.map((p) => path.join(home, p)), ...protectedPaths];
    for (const runtime of [lib, node]) {
      const denied = credentials.find((p) => SandboxPolicy.contains(p, runtime));
      if (denied)
        throw new SandboxError(
          `The sandbox runtime ${runtime} is inside the protected path ${denied}, which the worker cannot read. ` +
            `Install pi-kit and Node outside ${denied}.`,
          'RUNTIME_PROTECTED',
        );
    }
    const envFiles = ['.env', '.env.*', path.join('**', '.env'), path.join('**', '.env.*')].map((p) =>
      path.join(cwd, p),
    );
    const systems =
      process.platform === 'win32'
        ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files']
        : [
            '/usr',
            '/opt/homebrew',
            '/bin',
            '/sbin',
            '/lib',
            '/lib64',
            '/System',
            '/Library',
            '/dev',
            '/proc',
            '/etc',
            '/private/etc',
            // macOS /bin/sh reads this symlink to pick its shell; without it every sh prints EPERM noise.
            '/private/var/select',
          ];
    const immutable = [path.dirname(lib), path.join(cwd, 'node_modules'), node, ...protectedPaths];
    return {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: [path.parse(cwd).root],
        allowRead: [...systems, cwd, temp, lib, node].map((p) => ({ path: p, literal: true })),
        allowWrite: [
          { path: cwd, literal: true },
          { path: temp, literal: true },
        ],
        denyWrite: [...immutable.map((p) => ({ path: p, literal: true as const })), ...envFiles],
      },
      // SRT's allowRead beats a nested denyRead, so .env files and credentials need credential denies to stay unreadable.
      credentials: { files: [...envFiles, ...credentials].map((p) => ({ path: p, mode: 'deny' })) },
      ...(helpers.seccomp ? { seccomp: { applyPath: helpers.seccomp } } : {}),
      ...(helpers.srtWin ? { windows: { srtWin: { path: helpers.srtWin } } } : {}),
      ...(helpers.javaAgent ? { javaAgentJarPath: helpers.javaAgent } : {}),
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    };
  }

  private static isLiteralPath(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length <= 32768 &&
      path.isAbsolute(value) &&
      !value.includes('\0') &&
      !SandboxPolicy.GLOB.test(value)
    );
  }
}
