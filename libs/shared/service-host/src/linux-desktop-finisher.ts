import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface LinuxDesktopFinisherOptions {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A narrow command seam: tests do not start a user service or an updater. */
export interface LinuxDesktopFinisherSystem {
  run(file: string, args: string[]): void;
}

/**
 * setsid/detached only leaves the process group, not the service cgroup. A
 * backend's KillMode=mixed would still kill that child when the host stops.
 * Let the user manager own a separate transient service instead (not a scope).
 * Type=exec and the absence of --no-block make systemd-run wait for successful
 * exec, rather than acknowledging a queued job or a fork. Failure is fatal:
 * never fall back to a child in the initiating host's cgroup.
 */
export function startLinuxDesktopFinisher(
  options: LinuxDesktopFinisherOptions,
  system: LinuxDesktopFinisherSystem = {
    run: (file, args) => {
      execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 });
    },
  },
): void {
  const unit = `pi-kit-desktop-update-${randomUUID()}.service`;
  const args = [
    '--user',
    '--quiet',
    '--collect',
    `--unit=${unit}`,
    '--service-type=exec',
    '--expand-environment=no',
    '--property=Restart=no',
    '--property=StandardInput=null',
    '--property=StandardOutput=null',
    '--property=StandardError=journal',
  ];
  // A user manager does not inherit the calling CLI's environment. In particular
  // Electron must run as Node and the same data/profile paths must be retained.
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) args.push(`--setenv=${key}=${value}`);
  }
  // Disable systemd's ExecStart $ expansion explicitly. Older systemd versions
  // without this option fail safely, rather than altering paths or script text.
  args.push('--', options.program, ...options.args);
  try {
    system.run('systemd-run', args);
  } catch (error) {
    throw new Error(
      'Cannot start the Linux desktop update finisher in a separate systemd user service. ' +
        'The update was not handed off; ensure the systemd user manager is available and retry. ' +
        'Refusing an unsafe detached-process fallback.',
      { cause: error },
    );
  }
}
