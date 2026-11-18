import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export interface DaemonUpdateRestart {
  restart(): Promise<void>;
  close(): void;
}

/** A narrow spawn seam so tests never need to invoke sudo, including on macOS. */
export interface DaemonUpdateRestartInjection {
  spawn?: (
    file: string,
    args: string[],
    options: { stdio: ['pipe', 'pipe', 'pipe'] },
  ) => EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable };
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
}

// Intentionally constant: the only variable argument is a validated launchd target in $1.
// Do not use eval, accept arbitrary commands, or re-run sudo after the host has stopped.
const helperScript = `printf 'READY\\n'
while IFS= read -r command; do
  case "$command" in
    restart)
      if /bin/launchctl kickstart "$1"; then
        printf 'OK\\n'
      else
        printf 'ERROR\\n'
      fi
      ;;
    close) exit 0 ;;
    *) exit 2 ;;
  esac
done
`;

/**
 * Reserve a privileged macOS restart BEFORE stopping the service. READY proves that
 * sudo has actually started the root shell, not just that `sudo -l` permits a command.
 * The shell holds that authorization until close/EOF, even if the sudo cache expires.
 * Call close in finally, including after a failed swap or restart.
 */
export async function reserveDaemonUpdateRestart(
  serviceName: string,
  injection: DaemonUpdateRestartInjection = {},
): Promise<DaemonUpdateRestart> {
  if (/^dev\.pi-kit\.app\.service(?:\.[a-f0-9]{8})?$/.exec(serviceName)?.[0] !== serviceName)
    throw new Error('Invalid daemon update service name.');

  let stderr = '';
  let buffer = '';
  let closed = false;
  let terminal: Error | undefined;
  let pending:
    | { expected: 'READY' | 'OK'; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  const diagnostic = (reason: string) =>
    new Error(
      `Cannot reserve/restart the macOS service: ${reason}. ` +
        'Silent updates require passwordless sudo or valid cached sudo credentials before the service stops; no password prompt is allowed.' +
        (stderr.trim() ? `\nsudo/launchctl: ${stderr.trim()}` : ''),
    );
  const child = (injection.spawn ?? spawn)(
    '/usr/bin/sudo',
    ['-n', '/bin/sh', '-c', helperScript, '--', `system/${serviceName}`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const close = () => {
    if (closed) return;
    closed = true;
    // EOF releases the privileged shell; no further privileged command is sent.
    child.stdin.end();
    if (pending) {
      const wait = pending;
      pending = undefined;
      clearTimeout(wait.timer);
      wait.reject(diagnostic('restart reservation closed'));
    }
  };
  const fail = (reason: string) => {
    terminal = diagnostic(reason);
    if (pending) {
      const wait = pending;
      pending = undefined;
      clearTimeout(wait.timer);
      wait.reject(terminal);
    }
    close();
  };
  const waitFor = (expected: 'READY' | 'OK', timeout: number): Promise<void> =>
    new Promise((resolve, reject) => {
      pending = {
        expected,
        resolve,
        reject,
        timer: setTimeout(() => fail(`timed out waiting for ${expected}`), timeout),
      };
    });

  child.stderr.on('data', (chunk: Buffer | string) => {
    // Keep the most recent diagnostics, without allowing an unbounded privileged output buffer.
    stderr = (stderr + chunk.toString()).slice(-16_384);
  });
  child.stdin.on('error', (error: Error) => fail(`helper input failed: ${error.message}`));
  child.stdout.on('error', (error: Error) => fail(`helper output failed: ${error.message}`));
  child.stderr.on('error', (error: Error) => fail(`helper diagnostics failed: ${error.message}`));
  child.on('error', (error: Error) => fail(`could not start sudo: ${error.message}`));
  // close, unlike exit, follows the final stderr data (notably sudo's password-required message).
  child.on('close', (code: number | null, signal: string | null) => {
    if (!closed) fail(`privileged helper exited (${signal ?? code ?? 'unknown status'})`);
  });
  child.stdout.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const wait = pending;
      if (!wait || (line !== wait.expected && !(wait.expected === 'OK' && line === 'ERROR'))) {
        fail('unexpected privileged helper response');
        return;
      }
      pending = undefined;
      clearTimeout(wait.timer);
      if (line === 'ERROR') wait.reject(diagnostic('launchctl kickstart failed'));
      else wait.resolve();
    }
    if (buffer.length > 16_384) fail('oversized privileged helper response');
  });

  await waitFor('READY', injection.readyTimeoutMs ?? 10_000);
  return {
    async restart() {
      if (terminal) throw terminal;
      if (closed) throw diagnostic('restart reservation closed');
      if (pending) throw diagnostic('restart already in progress');
      const response = waitFor('OK', injection.commandTimeoutMs ?? 30_000);
      try {
        child.stdin.write('restart\n');
      } catch (error) {
        fail(`helper input failed: ${String(error)}`);
      }
      await response;
    },
    close,
  };
}
