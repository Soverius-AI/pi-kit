import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Fallbacks for GUI launches where shell startup fails or takes longer than its timeout. */
function nodeToolDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = homedir();
  const nvm = join(env['NVM_DIR'] || join(home, '.nvm'), 'versions', 'node');
  let versions: string[] = [];
  try {
    versions = readdirSync(nvm).filter((name) => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    // nvm is optional.
  }
  return [
    env['NVM_BIN'],
    join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), 'pi-node', 'current', 'bin'),
    join(env['VOLTA_HOME'] || join(home, '.volta'), 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...versions.map((version) => join(nvm, version, 'bin')),
  ].filter((dir): dir is string => {
    if (!dir) return false;
    try {
      accessSync(join(dir, 'node'), constants.X_OK);
      accessSync(join(dir, 'npm'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * A macOS app started from Finder or the Dock inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one the
 * user's terminal has, so pi's `bash` tool would not find `node`, `git` from Homebrew, `rg` and the rest. The login shell
 * knows the real PATH; ask it once at startup. Preserve its ordering, then the inherited path, and append installed Node/npm
 * toolchains so a slow or broken shell startup cannot leave pi's package manager unable to spawn npm.
 */
export function loginShellPath(timeoutMs = 4000): string | undefined {
  if (process.platform === 'win32') return undefined;
  const shell = process.env['SHELL'] || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const marker = '__PI_KIT_PATH__';
  // Separate arguments keep the trailing marker out of the shell variable name.
  const result = spawnSync(shell, ['-ilc', `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  const match = result.status === 0 ? new RegExp(`${marker}(.*?)${marker}`, 's').exec(result.stdout) : undefined;
  const paths = [match?.[1], process.env['PATH'], ...nodeToolDirectories(process.env)]
    .filter((path): path is string => !!path)
    .flatMap((path) => path.split(delimiter))
    .filter(Boolean);
  return [...new Set(paths)].join(delimiter) || undefined;
}
