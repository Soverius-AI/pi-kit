import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/** What the operating system starts at sign-in: the program, its arguments and its whole environment. */
export interface ServiceSpec {
  /** The launchd label or systemd unit name. */
  name: string;
  description: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  logDir: string;
}

export type RunCommand = (file: string, args: string[]) => Promise<{ code: number; output: string }>;

/** Runs a command in this terminal, so that it can ask the person for a password itself. */
export const runInTerminal: RunCommand = (file, args) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: '' }));
  });

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

/** A registration with the operating system's own service manager, per user, started at sign-in. */
export interface ServiceManager {
  /** Why this system cannot run the service, or undefined when it can. */
  unsupported(): Promise<string | undefined>;
  installed(): boolean;
  /** Writes and loads the registration when it differs from the spec; `true` when it changed. */
  install(): Promise<boolean>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  /** Stops the running host and starts it again on the current registration. */
  restart(): Promise<void>;
  /** The program and arguments the current registration starts, whichever install wrote it. */
  registered(): string[] | undefined;
  /** How the service starts at boot with nobody signed in, when it does not yet; undefined when it does. */
  bootNote?(): Promise<string | undefined>;
}

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A launchd job; `userName` makes it a LaunchDaemon's, run as that user from the system domain. */
export function launchAgentPlist(spec: ServiceSpec, userName?: string): string {
  const strings = (values: string[]) => values.map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const env = Object.entries(spec.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.name)}</string>
${userName ? `  <key>UserName</key>\n  <string>${xml(userName)}</string>\n` : ''}  <key>ProgramArguments</key>
  <array>
${strings([spec.program, ...spec.args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>${xml(join(spec.logDir, 'service-stderr.log'))}</string>
</dict>
</plist>
`;
}

const unxml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');

/** The ProgramArguments of a plist `launchAgentPlist` wrote. */
export function launchAgentArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]));
}

/** systemd's quoting: a double-quoted word, with `%` and `$` doubled so systemd expands neither. */
const unitWord = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${unitWord(`${key}=${value}`)}`)
    .join('\n');
  return `[Unit]
Description=${spec.description}

[Service]
Type=simple
ExecStart=${[spec.program, ...spec.args].map(unitWord).join(' ')}
${env}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** The ExecStart words of a unit `systemdUnit` wrote. */
export function systemdExecStart(unit: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? '';
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1].replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$'),
  );
}

function writeIfChanged(path: string, content: string, mode: number): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  return true;
}

/** macOS: a LaunchAgent in the user's domain; launchd starts it at sign-in and again after a crash. */
export class LaunchdService implements ServiceManager {
  private readonly plist: string;
  private readonly daemon: string;
  private readonly domain: string;
  private readonly job: string;

  constructor(
    private readonly spec: ServiceSpec,
    private readonly run: RunCommand = runCommand,
    home = homedir(),
    uid = process.getuid?.() ?? 0,
    daemons = '/Library/LaunchDaemons',
  ) {
    this.plist = join(home, 'Library', 'LaunchAgents', `${spec.name}.plist`);
    this.daemon = join(daemons, `${spec.name}.plist`);
    this.domain = `gui/${uid}`;
    this.job = `${this.domain}/${spec.name}`;
  }

  /** A LaunchAgent beside the LaunchDaemon would start a second host at sign-in, which launchd restarts forever. */
  async unsupported(): Promise<string | undefined> {
    return existsSync(this.daemon)
      ? 'pi-kit starts at boot on this Mac. To start it at sign-in instead, run "pi-kit service uninstall --level boot" first.'
      : undefined;
  }

  installed(): boolean {
    return existsSync(this.plist);
  }

  registered(): string[] | undefined {
    return existsSync(this.plist) ? launchAgentArguments(readFileSync(this.plist, 'utf8')) : undefined;
  }

  async install(): Promise<boolean> {
    const changed = writeIfChanged(this.plist, launchAgentPlist(this.spec), 0o644);
    const loaded = (await this.run('launchctl', ['print', this.job])).code === 0;
    if (loaded && !changed) return false;
    if (loaded) await this.run('launchctl', ['bootout', this.job]);
    await this.must(['bootstrap', this.domain, this.plist]);
    return true;
  }

  async uninstall(): Promise<void> {
    await this.run('launchctl', ['bootout', this.job]);
    rmSync(this.plist, { force: true });
  }

  async start(): Promise<void> {
    await this.must(['kickstart', this.job]);
  }

  async restart(): Promise<void> {
    await this.must(['kickstart', '-k', this.job]);
  }

  private async must(args: string[]): Promise<void> {
    const result = await this.run('launchctl', args);
    if (result.code !== 0) throw new Error(`launchctl ${args[0]} failed (${result.code}): ${result.output}`);
  }
}

/** Linux: a systemd user unit; systemd starts it with the user's session and again after a failure. */
export class SystemdService implements ServiceManager {
  private readonly unit: string;
  private readonly file: string;

  constructor(
    private readonly spec: ServiceSpec,
    private readonly run: RunCommand = runCommand,
    configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
  ) {
    this.unit = `${spec.name}.service`;
    this.file = join(configHome, 'systemd', 'user', this.unit);
  }

  async unsupported(): Promise<string | undefined> {
    const result = await this.run('systemctl', ['--user', 'show-environment']);
    return result.code === 0 ? undefined : 'This system has no systemd user session.';
  }

  installed(): boolean {
    return existsSync(this.file);
  }

  registered(): string[] | undefined {
    return existsSync(this.file) ? systemdExecStart(readFileSync(this.file, 'utf8')) : undefined;
  }

  async bootNote(): Promise<string | undefined> {
    const user = userInfo().username;
    const linger = await this.run('loginctl', ['show-user', user, '--property=Linger', '--value']);
    return linger.output.trim() === 'yes'
      ? undefined
      : `It starts when you sign in. To start it at boot with nobody signed in, run: loginctl enable-linger ${user}`;
  }

  async install(): Promise<boolean> {
    const changed = writeIfChanged(this.file, systemdUnit(this.spec), 0o644);
    if (changed) await this.must(['daemon-reload']);
    await this.must(['enable', this.unit]);
    if (changed) await this.must(['restart', this.unit]);
    else await this.must(['start', this.unit]);
    return changed;
  }

  async uninstall(): Promise<void> {
    await this.run('systemctl', ['--user', 'disable', '--now', this.unit]);
    rmSync(this.file, { force: true });
    await this.run('systemctl', ['--user', 'daemon-reload']);
  }

  async start(): Promise<void> {
    await this.must(['start', this.unit]);
  }

  async restart(): Promise<void> {
    await this.must(['restart', this.unit]);
  }

  private async must(args: string[]): Promise<void> {
    const result = await this.run('systemctl', ['--user', ...args]);
    if (result.code !== 0) throw new Error(`systemctl --user ${args[0]} failed (${result.code}): ${result.output}`);
  }
}

/**
 * macOS at boot, with nobody signed in: a LaunchDaemon that runs the host as its owner, never as root. The plist is root's, so
 * `sudo` writes and loads it and asks for the password in the terminal.
 */
export class LaunchDaemonService implements ServiceManager {
  private readonly plist: string;
  private readonly job: string;

  constructor(
    private readonly spec: ServiceSpec,
    private readonly sudo: RunCommand = (file, args) => runInTerminal('sudo', [file, ...args]),
    private readonly user = userInfo().username,
    private readonly home = homedir(),
    root = '/Library/LaunchDaemons',
  ) {
    this.plist = join(root, `${spec.name}.plist`);
    this.job = `system/${spec.name}`;
  }

  async unsupported(): Promise<string | undefined> {
    return undefined;
  }

  installed(): boolean {
    return existsSync(this.plist);
  }

  registered(): string[] | undefined {
    return existsSync(this.plist) ? launchAgentArguments(readFileSync(this.plist, 'utf8')) : undefined;
  }

  async install(): Promise<boolean> {
    const content = launchAgentPlist({ ...this.spec, env: { ...this.spec.env, HOME: this.home } }, this.user);
    if (existsSync(this.plist) && readFileSync(this.plist, 'utf8') === content) {
      await this.start();
      return false;
    }
    const staging = mkdtempSync(join(tmpdir(), 'pi-kit-daemon-'));
    try {
      const staged = join(staging, `${this.spec.name}.plist`);
      writeFileSync(staged, content, { mode: 0o644 });
      if (existsSync(this.plist)) await this.sudo('launchctl', ['bootout', this.job]);
      await this.must('install', ['-m', '644', '-o', 'root', '-g', 'wheel', staged, this.plist]);
      await this.must('launchctl', ['bootstrap', 'system', this.plist]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return true;
  }

  async uninstall(): Promise<void> {
    if (!existsSync(this.plist)) return;
    await this.sudo('launchctl', ['bootout', this.job]);
    await this.must('rm', ['-f', this.plist]);
  }

  async start(): Promise<void> {
    await this.must('launchctl', ['kickstart', this.job]);
  }

  async restart(): Promise<void> {
    await this.must('launchctl', ['kickstart', '-k', this.job]);
  }

  private async must(file: string, args: string[]): Promise<void> {
    const result = await this.sudo(file, args);
    if (result.code !== 0) throw new Error(`sudo ${file} ${args[0]} failed (${result.code})`);
  }
}
