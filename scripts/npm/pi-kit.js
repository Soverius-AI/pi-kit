#!/usr/bin/env node
// pi-kit from npm: runs this machine's platform package on the Node runtime that package carries. The Node running this
// file only starts it, so the service never depends on the Node that installed it.
'use strict';
const { spawn } = require('node:child_process');
const { dirname, join } = require('node:path');
const launcher = require('../package.json');

const name = `${launcher.name}-${process.platform}-${process.arch}`;
let root;
try {
  root = dirname(require.resolve(`${name}/package.json`));
} catch {
  const targets = Object.keys(launcher.optionalDependencies).map((dependency) =>
    dependency.slice(launcher.name.length + 1),
  );
  console.error(
    `pi-kit: ${name} is not installed. pi-kit runs on ${targets.join(', ')}; on one of them, install it again ` +
      'without --omit=optional or --no-optional.',
  );
  process.exit(1);
}

const runtime = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const child = spawn(runtime, [join(root, 'backend', 'pi-kit.cjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
// Ctrl+C reaches both processes from the terminal; a supervisor's signal reaches only this one.
process.on('SIGINT', () => undefined);
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(`pi-kit: could not start ${runtime}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
