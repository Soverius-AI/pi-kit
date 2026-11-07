import { describe, expect, it } from 'vitest';
import type { RpcPeer } from './host-channel';
import { type CliContext, runCli } from './service-cli';

/** The host as `pi-kit` reaches it: every call it was asked, answered from `answers` (a function per method). */
function host(answers: Record<string, (params: unknown) => unknown>) {
  const calls: Array<[string, unknown]> = [];
  const peer = {
    call: async (method: string, params?: unknown) => {
      calls.push([method, params]);
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer(params);
    },
    close: () => undefined,
  } as unknown as RpcPeer;
  const ctx: CliContext = {
    version: '0.0.0',
    serviceName: 'test',
    dataDir: '/tmp',
    logDir: '/tmp',
    manager: undefined,
    discover: () => ({ pid: 1, version: '0.0.0', level: 'login', socket: 's', token: 't', startedAt: 'now' }),
    connect: async () => peer,
    tail: () => undefined,
    sleep: async () => undefined,
  };
  return { calls, ctx };
}

function terminal(answer?: string) {
  const out: string[] = [];
  return {
    out,
    io: {
      out: (text: string) => void out.push(text),
      err: () => undefined,
      readLine: async () => answer,
      interactive: answer !== undefined,
    },
  };
}

const request = { id: 'r1', name: 'Phone', confirmationCode: '123456', expiresAt: Date.now() + 60_000 };

describe('pi-kit remote, pair and devices', () => {
  it('reports serving, or hands over the Tailscale approval link when Serve needs one', async () => {
    const serving = host({ 'remote.start': () => ({ state: 'serving', url: 'https://box.tail0.ts.net:8443' }) });
    const ok = terminal();
    expect(await runCli(['remote', 'enable', '--port', '8443'], ok.io, serving.ctx)).toBe(0);
    expect(serving.calls).toEqual([['remote.start', 8443]]);
    expect(ok.out.join('')).toContain('serving at https://box.tail0.ts.net:8443');

    const blocked = host({
      'remote.start': () => ({ state: 'error', message: 'Approve Tailscale Serve for this computer.' }),
      'remote.setupUrl': () => 'https://login.tailscale.com/f/serve?node=n1',
    });
    const approval = terminal();
    expect(await runCli(['remote', 'enable'], approval.io, blocked.ctx)).toBe(3);
    expect(approval.out.join('')).toContain('https://login.tailscale.com/f/serve?node=n1');
  });

  it.each([
    ['y', ['remote.approvePairing', 'r1']],
    ['n', ['remote.rejectPairing', 'r1']],
    [undefined, undefined],
  ])('pairs only on the owner’s answer after the code (%s)', async (answer, decision) => {
    let polls = 0;
    const { calls, ctx } = host({
      'remote.beginPairing': () => ({
        code: 'c',
        url: 'https://box.tail0.ts.net:8443/phone#c',
        expiresAt: Date.now() + 60_000,
      }),
      'remote.status': () => ({ state: 'serving', requests: ++polls > 1 ? [request] : [] }),
      'remote.approvePairing': () => undefined,
      'remote.rejectPairing': () => undefined,
    });
    const { out, io } = terminal(answer);
    expect(await runCli(['pair'], io, ctx)).toBe(0);
    expect(out.join('')).toContain('Its confirmation code is 123456');
    const decided = calls.filter(([method]) => method.endsWith('Pairing') && method !== 'remote.beginPairing');
    expect(decided).toEqual(decision ? [decision] : []);
    if (!decision) expect(out.join('')).toContain('pi-kit devices approve r1');
  });

  it.each([
    ['approve', 'remote.approvePairing'],
    ['reject', 'remote.rejectPairing'],
    ['revoke', 'remote.revokeDevice'],
  ])('devices %s acts on the id it is given', async (command, method) => {
    const { calls, ctx } = host({ [method]: () => undefined });
    expect(await runCli(['devices', command, 'd1'], terminal().io, ctx)).toBe(0);
    expect(calls).toEqual([[method, 'd1']]);
  });
});
