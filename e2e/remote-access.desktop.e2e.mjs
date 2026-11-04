// Requires production renderer/backend builds. No live Tailscale service is configured.
// pnpm exec nx run-many -t build -p renderer,backend && node --test e2e/remote-access.desktop.e2e.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import electron from 'electron';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
it(
  'pairs an iPhone-sized HTTPS browser and opens the production app without exposing the backend token',
  { timeout: 120_000 },
  async () => {
    const out = await mkdtemp(join(tmpdir(), 'pi-kit-phone-'));
    let child;
    try {
      const config = join(out, 'openssl.cnf');
      await writeFile(
        config,
        '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=phone.fixture.ts.net\n[v3]\nsubjectAltName=DNS:phone.fixture.ts.net\n',
      );
      const cert = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(out, 'key.pem'),
          '-out',
          join(out, 'cert.pem'),
          '-days',
          '1',
          '-config',
          config,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(cert.status, 0, `Could not generate isolated test certificate: ${cert.stderr}`);
      await build({
        absWorkingDir: root,
        entryPoints: ['e2e/support/remote-access-probe.ts'],
        outfile: join(out, 'main.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        target: 'node24',
        logLevel: 'silent',
      });
      const env = { ...process.env, PI_KIT_PHONE_TEST_DIR: out, PI_KIT_PHONE_TEST_ROOT: root };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(
        electron,
        [join(out, 'main.cjs'), `--user-data-dir=${join(out, 'profile')}`, '--proxy-server=direct://'],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 100_000);
      try {
        const exit = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        assert.equal(exit.code, 0, `Phone regression failed (${exit.signal ?? exit.code}):\n${output}`);
        assert.ok(output.includes('PASS HTTPS pairing'), output);
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(out, { recursive: true, force: true });
    }
  },
);
