import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxOptions } from './core.js';
import { closeSync, existsSync, openSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SandboxError } from './protocol.js';

export class SandboxPolicy {
  private static readonly GLOB = /[\r\n*?[\]{}]/;
  private static readonly ENV = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM'];
  /** Ubuntu strips /usr/bin/bwrap's capabilities, which SRT's seccomp helper needs; the Linux setup installs this copy. */
  static readonly LINUX_BWRAP = '/usr/local/libexec/pi-kit/bwrap';
  private static readonly WINDOWS_SYSTEM_ENV = [
    'SystemDrive',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'CommonProgramFiles',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
  ];
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

  /** Entry by entry, so the folders leading to the workspace stay listable; entries created later are not covered. */
  static profileDenies(home: string, cwd: string, allowed: string[]): string[] {
    if (!SandboxPolicy.contains(home, cwd) || !path.relative(home, cwd)) return [home];
    const denies: string[] = [];
    let dir = home;
    for (let rest = path.relative(home, cwd); rest; rest = path.relative(dir, cwd)) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [home];
      }
      for (const name of entries) {
        const entry = path.join(dir, name);
        if (!allowed.some((p) => SandboxPolicy.contains(entry, p)) && !SandboxPolicy.locked(entry)) denies.push(entry);
      }
      dir = path.join(dir, rest.split(path.sep)[0]);
    }
    return denies;
  }

  /** macOS: the /usr/bin shims of git, make and clang look this up through /var, which the sandbox cannot read. */
  private static developerDir(): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    try {
      return realpathSync('/private/var/select/developer_dir');
    } catch {
      return undefined;
    }
  }

  /** MXC cannot deny a file Windows holds open exclusively (the registry hive), which nothing can read anyway. */
  private static locked(file: string): boolean {
    // Elsewhere opening every entry could block on a FIFO.
    if (process.platform !== 'win32') return false;
    try {
      closeSync(openSync(file, 'r'));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EBUSY';
    }
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
    const developer = SandboxPolicy.developerDir();
    if (developer) {
      env.DEVELOPER_DIR = developer;
      env.PATH = `${path.join(developer, 'usr', 'bin')}:${env.PATH}`;
    }
    if (process.platform === 'win32') {
      env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
      env.WINDIR = env.SystemRoot;
      // Without it PowerShell and cmd cannot resolve `whoami` to whoami.exe.
      env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
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

  /** On Windows MXC's helpers need the system folders. */
  static supervisorEnv(): NodeJS.ProcessEnv {
    const env = SandboxPolicy.cleanEnv();
    if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    if (process.platform === 'win32')
      for (const key of SandboxPolicy.WINDOWS_SYSTEM_ENV) if (process.env[key]) env[key] = process.env[key];
    return env;
  }

  static compile(
    { cwd, protectedPaths = [] }: Pick<SandboxOptions, 'cwd' | 'protectedPaths'>,
    temp: string,
    helpers: { seccomp?: string; javaAgent?: string; ripgrep?: string },
  ): SandboxRuntimeConfig {
    const lib = path.dirname(fileURLToPath(import.meta.url));
    const home = os.homedir();
    const executable = path.dirname(process.execPath);
    // An app bundle's executable loads its frameworks from beside MacOS, so the whole Contents is the runtime.
    const node =
      process.platform === 'darwin' && path.basename(executable) === 'MacOS' ? path.dirname(executable) : executable;
    // pi-kit's scratch projects live in its data folder, inside ~/.config or ~/Library: those keep the way to the workspace open.
    const around = (p: string) => (SandboxPolicy.contains(p, cwd) ? SandboxPolicy.profileDenies(p, cwd, [cwd]) : [p]);
    const guarded = protectedPaths.flatMap(around);
    const credentials = [...SandboxPolicy.CREDENTIALS.map((p) => path.join(home, p)).flatMap(around), ...guarded];
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
    // MXC reads the whole system drive unless denied, so Windows denies the profile instead of the drive and needs no system allow list.
    const windows = process.platform === 'win32';
    const systems = windows
      ? []
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
    const developer = [SandboxPolicy.developerDir()].filter((p) => p !== undefined);
    const immutable = [path.dirname(lib), path.join(cwd, 'node_modules'), node, ...guarded].filter(
      // MXC writes nowhere outside the write roots and denies a write-denied path to reads too, which would lock the worker out of its runtime.
      (p) => !windows || [cwd, temp].some((root) => SandboxPolicy.contains(root, p)),
    );
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
        denyRead: windows ? SandboxPolicy.profileDenies(home, cwd, [cwd, temp, lib, node]) : [path.parse(cwd).root],
        allowRead: [...systems, ...developer, cwd, temp, lib, node].map((p) => ({ path: p, literal: true })),
        allowWrite: [
          { path: cwd, literal: true },
          { path: temp, literal: true },
        ],
        denyWrite: [...immutable.map((p) => ({ path: p, literal: true as const })), ...envFiles],
      },
      // SRT's allowRead beats a nested denyRead, so .env files and credentials need credential denies to stay unreadable.
      credentials: { files: [...envFiles, ...credentials].map((p) => ({ path: p, mode: 'deny' })) },
      ...(helpers.seccomp ? { seccomp: { applyPath: helpers.seccomp } } : {}),
      ...(windows ? { windows: { backend: 'mxc' as const } } : {}),
      ...(helpers.javaAgent ? { javaAgentJarPath: helpers.javaAgent } : {}),
      ...(helpers.ripgrep ? { ripgrep: { command: helpers.ripgrep } } : {}),
      ...(process.platform === 'linux' && existsSync(SandboxPolicy.LINUX_BWRAP)
        ? { bwrapPath: SandboxPolicy.LINUX_BWRAP }
        : {}),
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
