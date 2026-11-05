import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
}

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchAgentPlist(spec: ServiceSpec): string {
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
  <key>ProgramArguments</key>
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

function writeIfChanged(path: string, content: string, mode: number): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  return true;
}

/** macOS: a LaunchAgent in the user's domain; launchd starts it at sign-in and again after a crash. */
export class LaunchdService implements ServiceManager {
  private readonly plist: string;
  private readonly domain: string;
  private readonly job: string;

  constructor(
    private readonly spec: ServiceSpec,
    private readonly run: RunCommand = runCommand,
    home = homedir(),
    uid = process.getuid?.() ?? 0,
  ) {
    this.plist = join(home, 'Library', 'LaunchAgents', `${spec.name}.plist`);
    this.domain = `gui/${uid}`;
    this.job = `${this.domain}/${spec.name}`;
  }

  async unsupported(): Promise<string | undefined> {
    return undefined;
  }

  installed(): boolean {
    return existsSync(this.plist);
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
