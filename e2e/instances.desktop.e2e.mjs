// Isolated reciprocal instances + production PWA. No Tailscale, normal profiles, provider credentials or OS keychain changes.
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
  'reciprocally pairs independent instances and routes desktop/PWA projects without a central broker',
  { timeout: 180000 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'pi-kit-instances-'));
    let child;
    try {
      const config = join(scratch, 'openssl.cnf');
      await writeFile(
        config,
        '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=alpha.fixture.ts.net\n[v3]\nsubjectAltName=DNS:alpha.fixture.ts.net,DNS:beta.fixture.ts.net,DNS:gamma.fixture.ts.net\n',
      );
      const certificate = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(scratch, 'key.pem'),
          '-out',
          join(scratch, 'cert.pem'),
          '-days',
          '1',
          '-config',
          config,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(certificate.status, 0, 'Test TLS certificate generation failed.');
      await writeFile(
        join(scratch, 'lookup.cjs'),
        `const dns=require('node:dns');const original=dns.lookup;require('node:https').globalAgent.options.lookup=(host,options,callback)=>{if(/^(alpha|beta|gamma)\\.fixture\\.ts\\.net$/.test(host))return callback(null,options?.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);return original(host,options,callback);};`,
      );
      await build({
        absWorkingDir: root,
        entryPoints: ['e2e/support/instances-probe.ts'],
        outfile: join(scratch, 'main.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        target: 'node24',
        logLevel: 'silent',
      });
      const env = { ...process.env, PI_KIT_INSTANCE_TEST_ROOT: root, PI_KIT_INSTANCE_TEST_DIR: scratch };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(
        electron,
        [join(scratch, 'main.cjs'), `--user-data-dir=${join(scratch, 'browser')}`, '--proxy-server=direct://'],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (part) => (output += part));
      child.stderr.on('data', (part) => (output += part));
      const timer = setTimeout(() => child.kill('SIGKILL'), 165000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
        assert.equal(code, 0, output);
        assert.ok(output.includes('PASS reciprocal instances'), output);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
