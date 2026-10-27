# ADR-0009: Nx build and dev tooling with pnpm and a hoisted node_modules

Status: Accepted
Date: 2026-10-17

## Context

The repository is an Nx monorepo with three apps, and `nx serve` runs all of them in development. The Electron build tool, how
Electron starts the backend, which origin the renderer runs on in each mode and how the two development modes (desktop and
browser) authenticate against the backend need one answer. Every git worktree (one per thread, one per agent) needs its own
`node_modules` of about 2,800 packages, and an install that unpacks all of them again for each worktree is slow. Nx picks the
package manager from the lockfile it finds, so only one lockfile may exist. A symlinked `node_modules` layout cannot be used:
`scripts/package-stage.mjs` and `scripts/natives.mjs` walk `node_modules`, `electron-builder.config.cjs` requires
`node_modules/electron`, `terminal.service.ts` looks for `node_modules/node-pty`, and pi's packages are loaded by path.

## Decision

- **Toolchain.** Nx, Angular, NestJS and TypeScript. Every dependency is pinned exactly in the root `package.json`.
- **Package manager.** pnpm replaces npm. It is pinned exactly in `package.json` (`packageManager`); `pnpm install --frozen-lockfile` is the
  one install command; `pnpm run` and `pnpm exec` replace `npm run` and `npx`; the GitHub Action `pnpm/action-setup` is pinned exactly and takes
  its version from `packageManager`. `package-lock.json` and `.npmrc` do not exist. pi's managed install still runs `npm ci` against pi's own lockfile.
- **Layout.** `nodeLinker: hoisted` in `pnpm-workspace.yaml`: `node_modules` is one flat tree, so everything that looks into it keeps working, and
  pnpm links the files from its content-addressable store. `shamefully-hoist` is not used. `strictPeerDependencies: false` and `autoInstallPeers: true`
  replace `legacy-peer-deps`. `packages: ['!**']` matches no workspace package, so the root stays the one Nx project.
- **Install scripts.** `allowBuilds` in `pnpm-workspace.yaml` is the allowlist: `node-pty`, `nx`, `@parcel/watcher`, `lmdb`, `unrs-resolver`,
  `electron-winstaller`, `esbuild`, `msgpackr-extract`. `false` records a deliberate refusal: `better-sqlite3-multiple-ciphers` (its N-API prebuilds
  are what is loaded), `@scarf/scarf`, `protobufjs`, `@google/genai`. A new dependency with an install script is a decision made in this file.
- **Overrides and patches.** Every dependency resolves one Zod 4 through the workspace override. Exact-version pnpm patches migrate the SDK record
  schemas, externalise CopilotKit's KaTeX fonts and share the highlight.js registry (`patches/README.md`). The root `postinstall` fingerprints the
  lockfile, overrides and patches so a dependency change invalidates Angular's persistent transform cache; Nx includes both in its build and test inputs.
  The renderer budget is 3.5 MB warning / 4 MB error; uncommon grammars and side panel contents load on demand.
- **Electron build.** `@nx/esbuild` bundles `apps/desktop/src/main.ts` and `preload.ts` into `dist/apps/desktop/{main,preload}.cjs` with `electron` external.
- **Backend child process.** Electron main runs `dist/apps/backend/main.js` with `process.execPath`, `ELECTRON_RUN_AS_NODE=1`, `NODE_ENV=production`,
  a free loopback port and a random 32-byte hex token, and waits for `GET /api/health` before opening the window.
- **Renderer origin.** Desktop development starts Angular on port `0` and receives the bound URL over IPC (`PI_KIT_DEV_RENDERER_PORT` pins it);
  Electron starts only after that result. Browser development uses `localhost:4200`. Production serves `dist/apps/renderer/browser` from the
  privileged `app://pi-kit/` scheme with a CSP that allows only the page's origin and the backend URL; the backend's CORS list (`PI_KIT_ORIGIN`) is
  that origin. Critical-CSS inlining is off because it emits inline handlers the CSP forbids. `getBackendUrl` and `getToken` IPC answer only that origin.
- **Browser dev mode.** `pnpm run dev:web` runs the backend on `127.0.0.1:4300` with `NODE_ENV=development` and a fresh token, and the renderer on
  `:4200`. Only in that mode the backend serves `GET /api/dev/token` (no bearer; the `Origin` header must be on the CORS list); the renderer keeps the
  token in `localStorage`. Electron never sets `NODE_ENV=development`, so the endpoint does not exist there.
- **Dev orchestration.** `pnpm run dev` and `pnpm run dev:web` call `scripts/dev.mjs`, which runs `concurrently` with the right environment. `pnpm run dev`
  rebuilds the backend with `esbuild --watch`; Electron is restarted for backend changes and waits for two structured readiness events, the bound renderer
  URL and a successful backend build; file existence is not a readiness signal. Dependency targets are built through Nx before the watch starts.
- **Fail closed.** The backend refuses to start without `PI_KIT_TOKEN` (16+ characters) and `PI_KIT_PORT`. The bearer guard is global; routes opt out with `@Public()`.

## Consequences

- A new worktree installs from the shared store: no resolution and no network after the first install; the one lockfile is the one Nx reads.
- Arguments follow the script name without `--` (`pnpm run e2e --file a-chat`); the scripts use `parseArgs`.
- `pnpm pack` packs the local project only, so `scripts/natives.mjs` downloads the other platforms' `@napi-rs/keyring-*` tarballs itself and
  checks them against the integrity in `pnpm-lock.yaml`.
- pnpm sets `npm_*`, `pnpm_*` and `PNPM_*` variables and a relative `./node_modules/.bin` on PATH; `shellEnvironment` hides them from terminals.
- Packaging reuses the `app://` serving and the child-process spawn; only the entry paths change.
- There is no hot-reload loop for the backend inside Electron; backend work uses `dev:web`.
- Every launch path has to supply a token and a port; a misconfigured start fails rather than opening an unauthenticated backend.
