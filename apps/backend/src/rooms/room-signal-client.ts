import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Private stdio only: never opens signal-cli's unauthenticated HTTP/TCP daemon. */
export class SignalCliClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  async start(binary: string, dataDir: string): Promise<void> {
    if (this.child) return;
    const child = spawn(binary, ['--data-dir', dataDir, 'jsonRpc', '--receive-mode', 'manual'], {
      stdio: 'pipe',
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    // Protocol diagnostics can contain account details. Never expose or retain them.
    child.stderr.resume();
    child.stdin.on('error', () => this.fail('Signal CLI connection closed.'));
    child.stdout.on('error', () => this.fail('Signal CLI connection closed.'));
    child.on('error', () => this.fail('Signal CLI could not start. Check its executable path and Java runtime.'));
    child.on('exit', () => {
      if (this.child === child) {
        this.child = undefined;
        this.fail('Signal CLI stopped. Reconnect Signal.');
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('Signal CLI could not start.')));
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error('Signal CLI is disconnected.'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Signal request timed out. Reconnect and try again.'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          clearTimeout(timer);
          pending?.reject(new Error('Signal CLI connection closed.'));
        }
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.buffer = '';
    this.fail('Signal connection was cancelled.');
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) {
      this.fail('Signal provisioning response is too large.');
      void this.close();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: { id?: string; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        this.fail('Signal CLI returned invalid JSON.');
        void this.close();
        return;
      }
      const id = typeof message.id === 'string' ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error('Signal CLI rejected the request. Reconnect Signal or check its local account.'));
      else pending.resolve(message.result);
    }
  }
  private fail(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
