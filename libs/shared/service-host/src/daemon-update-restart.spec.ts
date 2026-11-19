import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reserveDaemonUpdateRestart, type DaemonUpdateRestartInjection } from './daemon-update-restart';

const service = 'dev.pi-kit.app.service';
function helper() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let input = '';
  child.stdin.on('data', (chunk) => (input += chunk.toString()));
  const spawn = vi.fn<NonNullable<DaemonUpdateRestartInjection['spawn']>>(() => child);
  return { child, spawn, input: () => input };
}

async function ready(h = helper()) {
  const reservation = reserveDaemonUpdateRestart(service, { spawn: h.spawn });
  h.child.stdout.write('READY\n');
  return { ...h, reservation: await reservation };
}

afterEach(() => vi.useRealTimers());

describe('reserveDaemonUpdateRestart', () => {
  it('actually starts a noninteractive privileged helper before resolving, with only a validated positional target', async () => {
    const h = helper();
    let resolved = false;
    const waiting = reserveDaemonUpdateRestart(`${service}.0123abcd`, { spawn: h.spawn }).then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    const [file, args, options] = h.spawn.mock.calls[0];
    expect(file).toBe('/usr/bin/sudo');
    expect(args.slice(0, 4)).toEqual(['-n', '/bin/sh', '-c', expect.any(String)]);
    expect(args.slice(4)).toEqual(['--', `system/${service}.0123abcd`]);
    expect(options).toEqual({ stdio: ['pipe', 'pipe', 'pipe'] });
    expect(args[3]).not.toContain(service);
    expect(args[3]).toContain('/bin/launchctl kickstart "$1"');
    expect(args[3]).toContain('IFS= read -r command');
    expect(args[3]).toContain('close) exit 0');
    expect(args[3]).toContain('*) exit 2');
    h.child.stdout.write('REA');
    h.child.stdout.write('DY\n');
    const reservation = await waiting;
    reservation.close();
  });

  it.each([
    '',
    'system/dev.pi-kit.app.service',
    `${service};id`,
    `${service}\n`,
    `${service}.ABCDEF01`,
    `${service}.1234567`,
    'other.service',
  ])('rejects unsafe or unrelated label %j before spawning', async (name) => {
    const h = helper();
    await expect(reserveDaemonUpdateRestart(name, { spawn: h.spawn })).rejects.toThrow('Invalid');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('reuses the already privileged shell for restarts and recovery without re-requesting sudo', async () => {
    const h = await ready();
    const restart = h.reservation.restart();
    expect(h.input()).toBe('restart\n');
    h.child.stdout.write('OK\n');
    await restart;
    const recovery = h.reservation.restart();
    h.child.stdout.write('OK\n');
    await recovery;
    expect(h.input()).toBe('restart\nrestart\n');
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.reservation.close();
    h.reservation.close();
    expect(h.child.stdin.writableEnded).toBe(true);
    await expect(h.reservation.restart()).rejects.toThrow('closed');
  });

  it('preserves sudo diagnostics and fails before READY when credentials are unavailable', async () => {
    const h = helper();
    const waiting = reserveDaemonUpdateRestart(service, { spawn: h.spawn });
    h.child.stderr.write('sudo: a password is required\n');
    h.child.emit('close', 1, null);
    await expect(waiting).rejects.toThrow(
      /no password prompt is allowed.*\nsudo\/launchctl: sudo: a password is required/,
    );
    expect(h.input()).toBe('');
    expect(h.child.stdin.writableEnded).toBe(true);
  });

  it('reports launchctl failure but permits recovery through the same reservation', async () => {
    const h = await ready();
    const failed = h.reservation.restart();
    h.child.stderr.write('Could not find service');
    h.child.stdout.write('ERROR\n');
    await expect(failed).rejects.toThrow('Could not find service');
    const retry = h.reservation.restart();
    h.child.stdout.write('OK\n');
    await retry;
    h.reservation.close();
  });

  it('bounds the READY wait and releases the helper by EOF', async () => {
    vi.useFakeTimers();
    const h = helper();
    const result = reserveDaemonUpdateRestart(service, { spawn: h.spawn, readyTimeoutMs: 25 });
    const rejection = expect(result).rejects.toThrow('timed out waiting for READY');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(h.child.stdin.writableEnded).toBe(true);
  });

  it('bounds command responses and never allows a late response to authorize a new command', async () => {
    vi.useFakeTimers();
    const h = helper();
    const waiting = reserveDaemonUpdateRestart(service, { spawn: h.spawn, commandTimeoutMs: 25 });
    h.child.stdout.write('READY\n');
    const reservation = await waiting;
    const rejection = expect(reservation.restart()).rejects.toThrow('timed out waiting for OK');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    h.child.stdout.write('OK\n');
    await expect(reservation.restart()).rejects.toThrow();
    expect(h.input()).toBe('restart\n');
    expect(h.child.stdin.writableEnded).toBe(true);
  });

  it('rejects concurrent commands and rejects an outstanding command on close', async () => {
    const h = await ready();
    const running = h.reservation.restart();
    await expect(h.reservation.restart()).rejects.toThrow('already in progress');
    h.reservation.close();
    await expect(running).rejects.toThrow('closed');
    expect(h.input()).toBe('restart\n');
  });

  it('handles spawn errors, pipe errors, unexpected protocol output, and early helper exit', async () => {
    for (const failure of ['spawn', 'pipe', 'protocol', 'exit']) {
      const h = helper();
      const waiting = reserveDaemonUpdateRestart(service, { spawn: h.spawn });
      if (failure === 'spawn') h.child.emit('error', new Error('ENOENT'));
      if (failure === 'pipe') h.child.stdin.emit('error', new Error('EPIPE'));
      if (failure === 'protocol') h.child.stdout.write('not READY\n');
      if (failure === 'exit') h.child.emit('close', null, 'SIGTERM');
      await expect(waiting).rejects.toThrow('Cannot reserve/restart');
      expect(h.child.stdin.writableEnded).toBe(true);
    }
  });
});
