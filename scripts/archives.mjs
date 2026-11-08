// tar.gz and zip for the server archives, on whichever tar the machine has.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

// Windows' own tar.exe is bsdtar; the GNU tar of Git Bash, first on PATH in CI, reads `C:\` as a remote host and knows no zip.
export const tar =
  process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const bsdtar = execFileSync(tar, ['--version'], { encoding: 'utf8' }).includes('bsdtar');

export function unzip(archive, into) {
  if (bsdtar) execFileSync(tar, ['-xf', archive, '-C', into]);
  else execFileSync('unzip', ['-q', '-o', archive, '-d', into]);
}

export function zip(folder, archive) {
  const name = folder.split(/[\\/]/).pop();
  if (bsdtar) execFileSync(tar, ['-a', '-cf', archive, '-C', dirname(folder), name]);
  else execFileSync('zip', ['-q', '-r', archive, name], { cwd: dirname(folder) });
}

/** Unpacks a server archive, .tar.gz or .zip, into `into`. */
export function unpack(archive, into) {
  if (archive.endsWith('.zip')) unzip(archive, into);
  else execFileSync(tar, ['-xzf', archive, '-C', into]);
}
