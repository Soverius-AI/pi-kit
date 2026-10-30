import { spawn, spawnSync } from 'node:child_process';

export interface RunOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Every line of stdout and stderr, as it arrives. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Raw output chunks for consumers that retain a bounded tail, including commands with no line breaks. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Managed local runtimes/installers own their subprocess group as well as the immediate child. */
  processGroup?: boolean;
  onStart?: (pid: number) => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
}

/**
 * Runs a child process to its end and reports its output line by line (pi's updater, `npm ci`). Aborting the signal sends SIGTERM and,
 * if the process is still there after 5 s, SIGKILL. A command that cannot be started rejects.
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, signal: null, cancelled: true });
  return new Promise((resolve, reject) => {
    const grouped = options.processGroup && process.platform !== 'win32';
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: grouped, windowsHide: true });
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        // Windows has no process groups: a managed runtime's tree (llama-swap and the llama-server it started) ends through taskkill.
        if (options.processGroup && process.platform === 'win32' && child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        // ESRCH: nothing left to signal. EPERM: what macOS answers for a group whose leader is already gone (the SIGKILL after `close` lands there); nothing left either.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
    };
    const abort = (): void => {
      cancelled = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => { if (child.pid) options.onStart?.(child.pid); });
    for (const stream of ['stdout', 'stderr'] as const) {
      let pending = '';
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk: string) => {
        options.onOutput?.(chunk, stream);
        if (!options.onLine) return;
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) options.onLine(stripAnsi(line), stream);
      });
      child[stream].on('end', () => {
        if (pending.trim()) options.onLine?.(stripAnsi(pending), stream);
      });
    }
    child.on('error', (error) => {
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      // A managed command's detached descendants must not outlive their owner, including after its leader exits first.
      if (grouped) kill('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, signal, cancelled });
    });
  });
}

/** pi colours its output with ANSI escapes; the log and the progress line want the text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}
