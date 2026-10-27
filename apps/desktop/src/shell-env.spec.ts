import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginShellPath } from './shell-env';

describe.skipIf(process.platform === 'win32')('login shell PATH', () => {
  let dir: string;
  let shell: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pk-shell-env-'));
    shell = join(dir, 'login shell');
    vi.stubEnv('SHELL', shell);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('expands PATH in a real shell and excludes profile output without changing tool precedence or spaces', () => {
    // Run the probe passed after -ilc, surrounded by output a profile can print.
    const path = '/home/user/Node Tools/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
    writeFileSync(shell, `#!/bin/sh\nprintf "profile banner\\n"\nexport PATH='${path}'\n/bin/sh -c "$2"\nprintf "\\nprofile done\\n"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const actual = loginShellPath();
    expect(actual?.split(delimiter).slice(0, path.split(delimiter).length)).toEqual(path.split(delimiter));
    expect(actual).not.toMatch(/profile|__PI_KIT_PATH__/);
  });

  it('leaves the inherited environment available when the login shell fails', () => {
    writeFileSync(shell, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const inherited = process.env['PATH'];
    const inheritedPaths = [...new Set(inherited?.split(delimiter).filter(Boolean))];
    expect(loginShellPath()?.split(delimiter).slice(0, inheritedPaths.length)).toEqual(inheritedPaths);
    expect(process.env['PATH']).toBe(inherited);
  });
});
