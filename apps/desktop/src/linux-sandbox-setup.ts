import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Must match SandboxPolicy.LINUX_BWRAP in packages/pi-sandbox. */
export const LINUX_BWRAP = '/usr/local/libexec/pi-kit/bwrap';
const PROFILE = '/etc/apparmor.d/pi-kit-bwrap';

export const LINUX_SETUP_SCRIPT = `set -eu
install -D -m 0755 -o root -g root "$1" ${LINUX_BWRAP}
cat > ${PROFILE} <<'PROFILE'
# pi-kit's copy of bubblewrap for thread protection: it may create user namespaces that keep their capabilities.
abi <abi/4.0>,
include <tunables/global>

profile pi-kit-bwrap ${LINUX_BWRAP} flags=(unconfined) {
  userns,

  include if exists <local/pi-kit-bwrap>
}
PROFILE
chmod 0644 ${PROFILE}
apparmor_parser -r ${PROFILE}
`;

type Run = (file: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;

const runFile: Run = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: 300_000 }, (error, _stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr: String(stderr) }),
    ),
  );

/** pkexec asks for the password in the desktop session, which is why the app runs this and not the background service. */
export async function setUpLinuxSandbox(run: Run = runFile, bwrap = '/usr/bin/bwrap'): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Only Linux needs the sandbox setup.');
  if (!existsSync(bwrap)) throw new Error('bubblewrap is not installed. Install the bubblewrap package first.');
  const { code, stderr } = await run('pkexec', ['/bin/sh', '-c', LINUX_SETUP_SCRIPT, 'pi-kit-setup', bwrap]);
  // pkexec exits 126 when the password dialog was dismissed.
  if (code === 126) throw new Error('The setup was cancelled.');
  if (code !== 0) throw new Error(`The setup failed: ${stderr.trim() || `exit code ${code}`}`);
}
