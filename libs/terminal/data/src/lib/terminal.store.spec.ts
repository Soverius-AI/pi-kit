import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, terminalInput, terminalKill, terminalResize, terminalStart } from '@pi-kit/api';
import { HealthStore } from '@pi-kit/data-access';
import type { TerminalEvent, TerminalInfo } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { type TerminalHost, type TerminalSurface, TerminalStore } from './terminal.store';

const info = (cwd: string): TerminalInfo => ({ cwd, shell: '/bin/zsh', pid: 1, cols: 80, rows: 24, created: true });

describe('TerminalStore', () => {
  let onEvent: ((event: TerminalEvent) => void) | undefined;
  let endStream: ((error: Error) => void) | undefined;
  const api = {
    startTerminal: vi.fn(async (cwd: string, cols: number, rows: number) => {
      void [cols, rows];
      return info(cwd);
    }),
    terminalStream: vi.fn((cwd: string, handler: (event: TerminalEvent) => void, signal: AbortSignal) => {
      void cwd;
      onEvent = handler;
      return new Promise<void>((_resolve, reject) => {
        endStream = reject;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }),
    terminalInput: vi.fn(async (cwd: string, data: string) => {
      void [cwd, data];
    }),
    terminalResize: vi.fn(async (cwd: string, cols: number, rows: number) => {
      void [cwd, cols, rows];
    }),
    killTerminal: vi.fn(async (cwd: string) => {
      void cwd;
    }),
  };
  const health = { epoch: signal(0) };
  const surface: TerminalSurface = { cols: 100, rows: 30, write: vi.fn(), focus: vi.fn() };
  const host: TerminalHost = { open: vi.fn(async () => surface), close: vi.fn() };
  let threads: ReturnType<typeof fakeThreads>;

  const mounted = async () => {
    const terminal = TestBed.inject(TerminalStore);
    terminal.mount(host);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return terminal;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    onEvent = undefined;
    endStream = undefined;
    health.epoch.set(0);
    for (const fn of [...Object.values(api), surface.write, surface.focus, host.open, host.close])
      (fn as ReturnType<typeof vi.fn>).mockClear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: HealthStore, useValue: health },
        ...provideMockApi(
          [
            [terminalStart, api.startTerminal, (o) => [o.path?.['id'], o.body?.['cols'], o.body?.['rows']]],
            [terminalInput, api.terminalInput, (o) => [o.path?.['id'], o.body?.['data']]],
            [terminalResize, api.terminalResize, (o) => [o.path?.['id'], o.body?.['cols'], o.body?.['rows']]],
            [terminalKill, api.killTerminal, (o) => [o.path?.['id']]],
          ],
          [
            [
              /^\/api\/workspaces\/[^/]+\/terminal\/stream$/,
              api.terminalStream,
              (path, onLine, signal) => [decodeURIComponent(path.split('/')[3]), onLine, signal],
            ],
          ],
        ),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('does nothing while no panel is mounted', async () => {
    TestBed.inject(TerminalStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startTerminal).not.toHaveBeenCalled();
  });

  it('starts a shell sized to the screen, streams its output to it and focuses it', async () => {
    const terminal = await mounted();
    expect(api.startTerminal).toHaveBeenCalledWith('/a', 100, 30);
    expect(terminal.info()?.shell).toBe('/bin/zsh');
    expect(terminal.shellName()).toBe('zsh');
    expect(terminal.starting()).toBe(false);
    onEvent?.({ type: 'data', data: 'hello' } as TerminalEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(surface.write).toHaveBeenCalledWith('hello');
    expect(surface.focus).toHaveBeenCalled();
  });

  it('shows the exit of the shell', async () => {
    const terminal = await mounted();
    onEvent?.({ type: 'exit', exitCode: 3 } as TerminalEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(terminal.exited()).toBe(3);
  });

  it('a shell that cannot start is the error', async () => {
    api.startTerminal.mockRejectedValueOnce(new Error('no pty'));
    const terminal = await mounted();
    expect(terminal.error()).toBe('The terminal could not start: no pty');
    expect(terminal.starting()).toBe(false);
  });

  it('keystrokes go out in order, one request at a time, and typing meanwhile is joined', async () => {
    const terminal = await mounted();
    let release!: () => void;
    api.terminalInput.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    terminal.send('a');
    terminal.send('b');
    terminal.send('c');
    expect(api.terminalInput).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.terminalInput.mock.calls.map((c) => c[1])).toEqual(['a', 'bc']);
  });

  it('resizes are debounced', async () => {
    const terminal = await mounted();
    terminal.resize(90, 20);
    terminal.resize(91, 21);
    await vi.advanceTimersByTimeAsync(100);
    expect(api.terminalResize).toHaveBeenCalledTimes(1);
    expect(api.terminalResize).toHaveBeenCalledWith('/a', 91, 21);
  });

  it("switching folder attaches to the other folder's shell", async () => {
    await mounted();
    threads.open(thread('t2', { cwd: '/b' }));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startTerminal).toHaveBeenLastCalledWith('/b', 100, 30);
    expect(host.close).toHaveBeenCalled();
  });

  it('a new backend process (health epoch) attaches again', async () => {
    await mounted();
    health.epoch.set(1);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startTerminal).toHaveBeenCalledTimes(2);
  });

  it('a broken stream attaches again after a pause, and gives up after five times', async () => {
    const terminal = await mounted();
    endStream?.(new Error('reset'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startTerminal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.startTerminal).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 6; i++) {
      endStream?.(new Error('reset'));
      await vi.advanceTimersByTimeAsync(40_000);
    }
    expect(terminal.error()).toMatch(/The terminal connection was lost: reset/);
  });

  it('restart kills the shell and attaches a new one', async () => {
    const terminal = await mounted();
    await terminal.restart();
    expect(api.killTerminal).toHaveBeenCalledWith('/a');
    expect(api.startTerminal).toHaveBeenCalledTimes(2);
  });

  it('unmounting leaves the shell running and stops following', async () => {
    const terminal = await mounted();
    terminal.unmount();
    expect(api.killTerminal).not.toHaveBeenCalled();
    expect(terminal.info()).toBeUndefined();
    threads.open(thread('t2', { cwd: '/b' }));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startTerminal).toHaveBeenCalledTimes(1);
  });
});
