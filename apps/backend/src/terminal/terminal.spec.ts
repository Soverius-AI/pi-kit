import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalEvent } from '@pi-kit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultShell, shellEnvironment, TerminalService } from './terminal.service';

describe('shellEnvironment', () => {
  it("keeps the user's environment but not pi-kit's own variables, NODE_ENV, npm's and pnpm's or the repository's .bin on PATH", () => {
    const env = shellEnvironment({
      HOME: '/home/u',
      PATH: './node_modules/.bin:/repo/node_modules/.bin:/usr/bin:/bin',
      PI_KIT_TOKEN: 'secret',
      PI_KIT_PORT: '4300',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'development',
      npm_config_user_agent: 'pnpm/11.19.0',
      pnpm_config_verify_deps_before_run: 'false',
      PNPM_PACKAGE_NAME: 'pi-kit',
      INIT_CWD: '/repo',
      PI_CODING_AGENT_DIR: '/agent',
    });
    expect(env).toMatchObject({ HOME: '/home/u', PATH: '/usr/bin:/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor', PI_CODING_AGENT_DIR: '/agent' });
    expect(Object.keys(env).filter((k) => /^(PI_KIT_|ELECTRON_|npm_|pnpm_|PNPM_)|^(NODE_ENV|INIT_CWD)$/.test(k))).toEqual([]);
  });
});

describe('defaultShell', () => {
  it('is a login shell from $SHELL, /bin/sh without one, and the console shell on Windows', () => {
    expect(defaultShell({ SHELL: '/bin/zsh' }, 'darwin')).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(defaultShell({}, 'linux')).toEqual({ file: '/bin/sh', args: ['-l'] });
    expect(defaultShell({ COMSPEC: 'cmd.exe' }, 'win32')).toEqual({ file: 'cmd.exe', args: [] });
  });
});

describe.skipIf(process.platform === 'win32')('TerminalService (a real pseudo-terminal)', () => {
  const service = new TerminalService();
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pk-term-')));
  afterEach(() => service.onModuleDestroy());

  const collect = () => {
    const events: TerminalEvent[] = [];
    const off = service.subscribe(cwd, (e) => events.push(e));
    const text = () => events.map((e) => (e.type === 'data' ? e.data : '')).join('');
    // The user's login shell (zsh with its startup files) can take seconds to print under load: wait up to 15 s.
    const until = async (needle: string) => {
      for (let i = 0; i < 300 && !text().includes(needle); i++) await new Promise((r) => setTimeout(r, 50));
      return text();
    };
    return { events, off, until };
  };

  it('runs a command in the workspace folder, keeps one terminal per workspace and replays the output to a late client', async () => {
    const first = service.start(cwd, 80, 24);
    expect(first).toMatchObject({ cwd, cols: 80, rows: 24, created: true });
    const live = collect();
    service.write(cwd, 'echo "hello $((6*7))"; pwd\r');
    expect(await live.until('hello 42')).toContain('hello 42');

    const again = service.start(cwd, 100, 30);
    expect(again).toMatchObject({ pid: first.pid, created: false, cols: 100 });
    expect(service.has(cwd)).toBe(true);

    const late = collect();
    expect(await late.until('hello 42')).toContain('hello 42'); // from the scrollback, no new command
    expect(await late.until(cwd)).toContain(cwd);
  }, 40_000);

  it('reports the shell ending and starts a fresh terminal afterwards', async () => {
    service.start(cwd, 80, 24);
    const live = collect();
    service.write(cwd, 'exit 3\r');
    for (let i = 0; i < 300 && !live.events.some((e) => e.type === 'exit'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(live.events.find((e) => e.type === 'exit')).toMatchObject({ type: 'exit', exitCode: 3 });
    expect(service.has(cwd)).toBe(false);
    expect(service.start(cwd, 80, 24).created).toBe(true);
    expect(service.write('/nowhere', 'x')).toBe(false);
  }, 15_000);
});
