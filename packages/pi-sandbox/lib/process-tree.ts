import { spawn, type ChildProcess } from 'node:child_process';

export class ProcessTree {
  static exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  static waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
    if (ProcessTree.exited(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, ms);
      child.once('exit', onExit);
    });
  }

  /** Signals a POSIX process group; returns any failure other than the group already being gone. */
  static killGroup(pid: number | undefined, signal: NodeJS.Signals): Error | undefined {
    if (pid === undefined) return undefined;
    try {
      process.kill(-pid, signal);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? undefined : (error as Error);
    }
  }

  static taskkill(pid: number | undefined, env: NodeJS.ProcessEnv): ChildProcess {
    return spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', env, windowsHide: true });
  }

  static shellQuote(value: string): string {
    return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  }
}
