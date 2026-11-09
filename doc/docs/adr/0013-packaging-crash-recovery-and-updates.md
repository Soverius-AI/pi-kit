# ADR-0013: Packaging, release builds, crash recovery, pi update check and transcript performance

Status: Accepted
Date: 2026-10-15

## Context

pi-kit needs an installable package, a test that drives the real app, a backend that comes back after a crash, a way to see whether the bundled pi is out of date, and a transcript that stays usable with thousands of messages.
The backend is an esbuild CommonJS bundle with native modules and selected optional imports external. Packaging carries those native loaders and binaries, plus pi's bundled runtime assets, workers, WASM and themes.
Native modules (`better-sqlite3-multiple-ciphers`, `node-pty`, `@napi-rs/keyring`, `@earendil-works/pi-tui`) must be loadable and executable for each target CPU and OS.
A Dock-launched app inherits launchd's `PATH`, not the login shell's, and has no terminal for its output.
The renderer, the production CSP and the MCP App proxy URLs are bound to the backend's port and token chosen at launch.

## Decision

- **Backend outside the asar.** `app.asar` holds the Electron shell; `Resources/backend/` holds the bundled backend, migrations, assets, packages and native loaders as real files, and `Resources/renderer/` holds the browser build. This lets `ELECTRON_RUN_AS_NODE` run the backend, native binaries load and pi find its assets. `scripts/builder-after-pack.cjs` copies it in `afterPack` (before signing); `extraResources` cannot carry a `node_modules` folder.
- **Staging.** `scripts/package-stage.mjs` stages the Nx production artifacts, runtime assets and target-native binaries under `dist/stage/<platform>-<arch>/`. It does not copy a workspace dependency tree or create a second lockfile.
- **Natives per triple** (`scripts/natives.mjs`). Every shipped native is N-API, so nothing is rebuilt against Electron. Prebuilds come from the packages' own tarballs or verified tarball downloads checked against `pnpm-lock.yaml`'s integrity; a missing prebuild fails the build and never degrades to the host's binary. `verifyStaged` checks every binary's PE, Mach-O or ELF header and loads the host triple under Electron-as-Node.
- **One release command.** `pnpm run release [--only mac|win|linux|...]` builds once and packs per platform: macOS arm64 dmg and zip with `latest-mac.yml`; Windows x64 and arm64 NSIS and portable installers from one electron-builder run so both share `latest.yml`; Linux x64 and arm64 AppImages with separate `latest-linux*.yml` feeds, built only on a matching Linux host because node-pty compiles from source there. Windows builds on Apple Silicon use electron-builder's native arm64 toolsets.
- **Signing.** macOS uses hardened runtime with `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` and the network entitlements; no App Sandbox, because pi runs the user's shell. Without a Developer ID the app is ad-hoc signed; manual builds can opt into notarization and Windows signing through environment secrets; tag releases require macOS signing and notarization.
- **Packaged runtime.** The login shell's `PATH` comes first, then installed Node/npm directories from pi's managed Node, nvm, Volta and Homebrew; the default folder is `PI_KIT_CWD` or the user's home; macOS logs go to `~/Library/Logs/pi-kit/{main,service,backend}.log`, rotated at 5 MB; `uncaughtExceptionMonitor` writes a synchronous fatal stack without suppressing the exit.
- **Smoke test and CI.** `scripts/release-smoke.mjs` can launch the host platform's artifact with `PI_KIT_SMOKE=1`, a scratch world and a local model server to check health, natives, a prompt round trip and quit. `.github/workflows/release.yml` builds release targets on native runners; smoke tests are opt-in for manual runs, not run on tag releases. A `v*` tag publishes the GitHub release. Cross-built Windows arm64 binaries receive header checks, not a launch test on the x64 runner.
- **End-to-end tests** use Node's test runner and the `playwright` library, a scratch world under the temp folder, and `scripts/dev.mjs web`; `~/.pi/agent` is never read. `CHECK_E2E=1 pnpm run check` includes them.
- **Service-host watchdog** (`libs/shared/service-host/src/watchdog.ts`, pure, host injected): a health check moves `starting` to `running`; an exit or failed start restarts with backoff from 500 ms doubling to 15 s; five failures in a row end in `failed` with a Try again / Quit dialog; 30 s of uptime clears the count; a running backend is pinged every 5 s and killed after three misses.
- **Same port, same token** across restarts, so the window never reloads. State reaches windows as `pi-kit:backend-status`; `GET /api/health` returns a per-process `bootId`. `HealthService` bumps `epoch` on a changed `bootId` or a return after missed polls; `ChatStore` and `TerminalPanel` reconnect on `epoch`, and a broken replay stream retries at 1, 2, 4, 8 and 16 s.
- **pi update check.** `PiUpdateService` reports the loaded pi version (configured, managed or bundled), reads `https://pi.dev/api/latest-version`, honours `PI_OFFLINE` and `PI_SKIP_VERSION_CHECK`, and caches a success for ten minutes. This service only checks; the separate `UpdateService` owns update jobs and scheduled checks.
- **Transcript virtualization.** `VirtualTranscript` in `libs/chat/feature-chat` uses TanStack Angular Virtual for variable-height rows with eight overscan rows and measured heights. It restores per-thread reading positions and follows the tail when pinned. Finished markdown is cached by `MarkdownService.renderCached`.
- **Log compaction per run** (`log-compactor.ts`): each pass trims only rows after the previous snapshot, found through an indexed `type` column. Above `maxRows: 2000` every run except the newest `keepRuns: 10` is deleted outright, never past the newest snapshot. Rows after the last snapshot are never touched.
- **Session index.** `PiSessionService.scanSessions()` lists `(path, mtime, size)` and reads only new or changed files (`apps/backend/src/pi/session-index.ts`); `ThreadsService` upserts only those.

## Consequences

- Ad-hoc builds lack trusted macOS distribution and matching signed updates; tag releases require signing and notarization credentials.
- A crash during a run ends that run as aborted; the service-host watchdog does not resume it. `dev:web` has no watchdog, so a crashed backend there stays down until restarted, and the page reconnects when it is back.
- The virtualized transcript hides undrawn blocks from find-in-page; the full text stays in `ChatStore.messages()`.
- The e2e tests need a model server and the two dev ports, and run as slowly as the model answers.
