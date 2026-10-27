// Dev launcher.
//   node scripts/dev.mjs desktop   renderer dev server + backend watch build + Electron (pnpm run dev)
//   node scripts/dev.mjs web       backend + renderer dev server for a normal browser (pnpm run dev:web)
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// HTTPS_PROXY for the backend's own requests (the same rule as apps/desktop/src/proxy-env.ts): Node 24 honours the variables with NODE_USE_ENV_PROXY=1.
const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((name) => process.env[name]);
if (proxied) {
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',');
  Object.assign(process.env, { NODE_USE_ENV_PROXY: '1', NO_PROXY: noProxy, no_proxy: noProxy });
}

const mode = process.argv[2];
if (mode !== 'desktop' && mode !== 'web') {
  console.error('Usage: node scripts/dev.mjs <desktop|web>');
  process.exit(2);
}
let child = null;
const workers = new Set();
let builderFailed = false;
// The builder workers own their listening sockets and watchers; stop them with the rest of this launch.
process.on('exit', () => { for (const worker of workers) worker.kill(); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child ? child.kill(sig) : process.exit(0));

async function desktopBuilderReady(role) {
  const worker = fork(fileURLToPath(new URL('./dev-builder.mjs', import.meta.url)), [role], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  workers.add(worker);
  worker.on('exit', () => {
    builderFailed = true;
    if (child) child.kill('SIGTERM');
  });
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', () => reject(new Error(`The ${role} builder stopped before Electron started.`)));
    worker.on('message', (message) => {
      if (message?.type === `${role}-ready`) resolve(message.url);
    });
  });
}
// Browser development keeps stable ports; desktop development asks Angular for an available port each launch.
// Both support PI_KIT_DEV_RENDERER_PORT (and web supports PI_KIT_DEV_BACKEND_PORT). A browser then needs
// localStorage 'pi-kit.backendUrl' = the backend URL (the renderer reads that key).
const RENDERER_PORT = process.env.PI_KIT_DEV_RENDERER_PORT ?? '4200';
const BACKEND_PORT = process.env.PI_KIT_DEV_BACKEND_PORT ?? '4300';
let RENDERER_URL;
try {
  RENDERER_URL = mode === 'desktop'
    ? (await Promise.all([desktopBuilderReady('renderer'), desktopBuilderReady('backend')]))[0]
    : `http://localhost:${RENDERER_PORT}`;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const modes = {
  // Electron main starts the backend itself on a random port with a random token,
  // so here the backend is only kept built (esbuild --watch) and Electron is restarted by hand.
  desktop: {
    env: { PI_KIT_DEV_URL: RENDERER_URL },
    commands: [
      ['desktop', 'nx start desktop'],
    ],
  },
  // The browser has no preload, so the backend runs here on a fixed loopback port and hands the
  // token to the renderer through /api/dev/token (NODE_ENV=development only).
  web: {
    env: {
      NODE_ENV: 'development',
      PI_KIT_VERSION: JSON.parse(readFileSync('package.json', 'utf8')).version,
      PI_KIT_PORT: BACKEND_PORT,
      PI_KIT_TOKEN: process.env.PI_KIT_TOKEN ?? randomBytes(32).toString('hex'),
      PI_KIT_ORIGIN: RENDERER_URL,
      // dev:web keeps its database in the repository (git-ignored), apart from the desktop app's userData.
      PI_KIT_DATA_DIR: process.env.PI_KIT_DATA_DIR ?? `${process.cwd()}/.pi-kit-data`,
    },
    commands: [
      ['backend', 'nx serve backend'],
      ['renderer', `nx serve renderer --port ${RENDERER_PORT}`],
    ],
  },
};

const config = modes[mode];
if (builderFailed) process.exit(1);

child = spawn(
  'concurrently',
  ['--kill-others', '--names', config.commands.map(([n]) => n).join(','), ...config.commands.map(([, c]) => c)],
  { stdio: 'inherit', env: { ...process.env, ...config.env, PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}` } },
);
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(builderFailed ? 1 : code ?? 0));
