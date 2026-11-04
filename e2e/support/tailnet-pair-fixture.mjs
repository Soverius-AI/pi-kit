// node e2e/support/tailnet-pair-fixture.mjs [port-a,port-b]
// Needs production renderer/backend builds and a connected Tailscale with HTTPS certificates.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const out = join(root, 'tmp', 'tailnet-fixture');
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['e2e/support/tailnet-pair-fixture.ts'],
  outfile: join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'silent',
});
const child = spawn(process.execPath, [join(out, 'main.cjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PI_KIT_TAILNET_TEST_ROOT: root,
    PI_KIT_TAILNET_TEST_DIR: out,
    ...(process.argv[2] ? { PI_KIT_TAILNET_TEST_PORTS: process.argv[2] } : {}),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
