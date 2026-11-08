import { type ChildProcess, spawn } from 'node:child_process';
import type { BackendEndpoint } from './backend';

/** Keeps the computer from sleeping while it is idle; a closed lid or the user's own Sleep still sleep. */
export interface SleepGuard {
  hold(): void;
  release(): void;
}

/**
 * The command that holds an idle-sleep assertion until it is killed, and on its own lets go when `pid` (the host) exits, so a
 * crashed host never keeps the computer awake.
 */
export function sleepCommand(platform: NodeJS.Platform, pid: number): [string, string[]] | undefined {
  if (platform === 'darwin') return ['caffeinate', ['-i', '-w', String(pid)]];
  if (platform === 'linux')
    return [
      'systemd-inhibit',
      [
        '--what=idle',
        '--who=pi-kit',
        '--why=Agents are working',
        '--mode=block',
        'tail',
        `--pid=${pid}`,
        '-f',
        '/dev/null',
      ],
    ];
  if (platform === 'win32')
    return [
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED on this thread, held while it waits for the host.
        `$t = Add-Type -Name Power -Namespace PiKit -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; ` +
          `$null = $t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${pid}`,
      ],
    ];
  return undefined;
}

/** Holds the assertion with the platform's own command; where that command is missing it logs once and does nothing. */
export class CommandSleepGuard implements SleepGuard {
  private child: ChildProcess | undefined;
  private broken = false;

  constructor(
    private readonly command: [string, string[]] | undefined,
    private readonly log: (line: string) => void,
  ) {}

  hold(): void {
    if (this.child || this.broken || !this.command) return;
    const [file, args] = this.command;
    const child = spawn(file, args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    child.once('error', (error) => {
      this.broken = true;
      this.log(`cannot keep the computer awake (${file}: ${error.message})`);
    });
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
    });
    this.child = child;
    this.log('keeping the computer awake while agents work');
  }

  release(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    try {
      // The whole group: systemd-inhibit's own child as well.
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      // Already gone.
    }
    this.log('the computer may sleep again');
  }
}

/**
 * Follows the backend's status stream (`GET /api/threads/events`) and tells whether work is going on: a thread runs, or a
 * background agent is active. A thread that waits for an answer is not work; the computer may sleep while it waits. The
 * stream is entered again after it ends (a restarted backend), from a clean slate.
 */
export class BackendActivity {
  private readonly running = new Set<string>();
  private readonly agents = new Map<string, number>();
  private active = false;
  private abort: AbortController | undefined;
  private stopped = false;

  constructor(
    private readonly endpoint: () => BackendEndpoint | undefined,
    private readonly onChange: (active: boolean) => void,
    private readonly retryMs = 2_000,
  ) {}

  start(): void {
    void this.follow();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.update(true);
  }

  private async follow(): Promise<void> {
    while (!this.stopped) {
      this.running.clear();
      this.agents.clear();
      this.update();
      const endpoint = this.endpoint();
      if (endpoint) await this.read(endpoint).catch(() => undefined);
      if (this.stopped) return;
      await new Promise((resolve) => setTimeout(resolve, this.retryMs).unref());
    }
  }

  private async read(endpoint: BackendEndpoint): Promise<void> {
    this.abort = new AbortController();
    const response = await fetch(`${endpoint.url}/api/threads/events`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this.apply(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }

  private apply(event: Record<string, unknown>): void {
    const activity = (state: unknown) => (state as { activity?: unknown } | undefined)?.activity;
    if (event['type'] === 'snapshot') {
      this.running.clear();
      for (const [id, state] of Object.entries((event['states'] as Record<string, unknown>) ?? {}))
        if (activity(state) === 'running') this.running.add(id);
    } else if (event['type'] === 'state' && typeof event['id'] === 'string') {
      if (activity(event['state']) === 'running') this.running.add(event['id']);
      else this.running.delete(event['id']);
    } else if (event['type'] === 'gone' && typeof event['id'] === 'string') {
      this.running.delete(event['id']);
      this.agents.delete(event['id']);
    } else if (event['type'] === 'agents' && typeof event['id'] === 'string' && Array.isArray(event['agents'])) {
      const active = event['agents'].filter((agent) => (agent as { status?: unknown })?.status === 'active').length;
      if (active) this.agents.set(event['id'], active);
      else this.agents.delete(event['id']);
    } else return;
    this.update();
  }

  private update(ending = false): void {
    const active = !ending && (this.running.size > 0 || this.agents.size > 0);
    if (active === this.active) return;
    this.active = active;
    this.onChange(active);
  }
}
