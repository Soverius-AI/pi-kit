# ADR-0013: Packaging, release builds, crash recovery, pi update check and transcript performance

Status: Accepted
Date: 2026-10-15

## Context

pi-kit needs an installable package, a test that drives the real app, a backend that comes back after a crash, a way to see whether the bundled pi is out of date, and a transcript that stays usable with thousands of messages.
The backend is a webpack bundle that leaves every package external, so a package must carry `node_modules` next to it, and pi (ESM only, reading its own assets relative to its code) must be among them.
Native modules (`better-sqlite3-multiple-ciphers`, `node-pty`, `@napi-rs/keyring`, `@earendil-works/pi-tui`) must be loadable and executable for each target CPU and OS.
A Dock-launched app inherits launchd's `PATH`, not the login shell's, and has no terminal for its output.
The renderer, the production CSP and the MCP App proxy URLs are bound to the backend's port and token chosen at launch.

## Decision

- **Backend outside the asar.** `app.asar` holds the shell and the renderer; `Resources/backend/` holds `main.js`, `migrations/` and a `node_modules/` closure as real files, so `ELECTRON_RUN_AS_NODE` can run it, `.node` files and `spawn-helper` load, and pi finds its assets. `scripts/builder-after-pack.cjs` copies it in `afterPack` (before signing); `extraResources` cannot carry a `node_modules` folder.
- **Staging without network.** `scripts/package-stage.mjs` walks the dependency graph from the workspace's own `node_modules` (no second lockfile), strips source maps and type declarations outside pi, and stages one backend per target triple under `dist/stage/<platform>-<arch>/backend`.
- **Natives per triple** (`scripts/natives.mjs`). Every shipped native is N-API, so nothing is rebuilt against Electron. Prebuilds come from the packages' own tarballs or an `npm pack` checked against `package-lock.json`'s integrity; a missing prebuild fails the build and never degrades to the host's binary. `verifyStaged` checks every binary's PE, Mach-O or ELF header and loads the host triple under Electron-as-Node.
- **One release command.** `npm run release [--only mac|win|linux|...]` builds once and packs per platform: macOS arm64 dmg and zip with `latest-mac.yml`; Windows x64 and arm64 NSIS and portable installers from one electron-builder run so both share `latest.yml`; Linux x64 and arm64 AppImages with separate `latest-linux*.yml` feeds, built only on a matching Linux host because node-pty compiles from source there. Windows builds on Apple Silicon use electron-builder's native arm64 toolsets.
- **Signing.** macOS uses hardened runtime with `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` and the network entitlements; no App Sandbox, because pi runs the user's shell. Without a Developer ID the app is ad-hoc signed; notarization and Windows signing are opt-in through environment secrets.
- **Packaged runtime.** The login shell's `PATH` comes first, then installed Node/npm directories from pi's managed Node, nvm, Volta and Homebrew; the default folder is `PI_KIT_CWD` or the user's home; logs go to `~/Library/Logs/pi-kit/{main,backend}.log`, rotated at 5 MB; `uncaughtExceptionMonitor` writes a synchronous fatal stack without suppressing the exit.
- **Smoke test and CI.** `scripts/release-smoke.mjs` launches each artifact with `PI_KIT_SMOKE=1` against a scratch world and its own model server and asserts health, natives, one prompt round trip and a clean quit. `.github/workflows/release.yml` builds and smoke-tests every platform on native runners and drafts a GitHub release on a `v*` tag.
- **End-to-end tests** use Node's test runner and the `playwright` library, a scratch world under the temp folder, and `scripts/dev.mjs web`; `~/.pi/agent` is never read. `CHECK_E2E=1 npm run check` includes them.
- **Watchdog** (`apps/desktop/src/watchdog.ts`, pure, host injected): a health check moves `starting` to `running`; an exit or failed start restarts with backoff from 500 ms doubling to 15 s; five failures in a row end in `failed` with a Try again / Quit dialog; 30 s of uptime clears the count; a running backend is pinged every 5 s and killed after three misses.
- **Same port, same token** across restarts, so the window never reloads. State reaches windows as `pi-kit:backend-status`; `GET /api/health` returns a per-process `bootId`. `HealthService` bumps `epoch` on a changed `bootId` or a return after missed polls; `ChatSession` and `TerminalPanel` reconnect on `epoch`, and a broken replay stream retries at 1, 2, 4, 8 and 16 s.
- **pi update check.** Settings › General shows pi-kit's version, the bundled pi's version and an update line. `PiUpdateService` reads `https://pi.dev/api/latest-version` when Settings opens, honours `PI_OFFLINE` and `PI_SKIP_VERSION_CHECK`, caches a success for ten minutes, and never installs anything.
- **Transcript virtualization** above `VIRTUAL_ABOVE_MESSAGES` (1,000): blocks within 1,500 px of the viewport are drawn, two spacers stand for the rest, heights come from a `ResizeObserver` (entries of disconnected targets ignored), `overflow-anchor: none` with manual anchor restore, and a followed thread draws its tail. Gaps `TURN_GAP_PX` and `MARKER_GAP_PX` must match `components.css`. Finished markdown is cached (`MarkdownService.renderCached`, 400 entries).
- **Log compaction per run** (`log-compactor.ts`): each pass trims only rows after the previous snapshot, found through an indexed `type` column. Above `maxRows: 2000` every run except the newest `keepRuns: 10` is deleted outright, never past the newest snapshot. Rows after the last snapshot are never touched.
- **Session index.** `PiSessionService.scanSessions()` lists `(path, mtime, size)` and reads only new or changed files (`apps/backend/src/pi/session-index.ts`); `ThreadsService` upserts only those.

## Consequences

- A package is about 190 MB of backend plus the shell; pruning unused `@copilotkit/runtime` integrations is the largest saving left.
- Ad-hoc builds run locally but cannot be distributed and update nobody; a release needs a Developer ID, notarization and signing secrets.
- A crash during a run ends that run as aborted; the watchdog does not resume it. `dev:web` has no watchdog, so a crashed backend there stays down until restarted, and the page reconnects when it is back.
- The virtualized transcript hides undrawn blocks from find-in-page; the full text stays in `ChatSession.messages()`.
- A change of block spacing in `components.css` must change the transcript's gap constants too.
- The e2e tests need a model server and the two dev ports, and run as slowly as the model answers.
- Staged backends and packed apps for all targets need about 4 GB under `dist/`.
