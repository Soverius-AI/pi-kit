# Native macOS service integration results

Tested **on this Mac**, not in Docker, on 2026-11-07. Source: `feat/always-on-service`, base commit `9ef77b2` plus the onboarding-completion fix.

## Environment and isolation

- macOS 26.5.1 (build 25F80), Darwin 25.5.0, Apple Silicon, user UID 501.
- Real packaged `dist/release/mac-arm64/pi-kit.app`, app 0.10.9, Electron 44.9.0 / Node 24.22.0.
- Native packaging used the same current, platform-neutral JS build artifacts as the preceding Linux test, then provisioned and verified **Darwin ARM64** native modules on the Mac. Runtime was entirely native macOS.
- Ad-hoc signed local app; `codesign --verify --deep --strict` passed. This was not a Developer ID/notarized release.
- Native module checks loaded SQLite, keyring, keychain-store, CUA SDK/runtime, and PTY; PTY spawned `/bin/echo`. Loading keychain-store did not read credentials.
- Real **per-user LaunchAgent** in `~/Library/LaunchAgents`, label `dev.pi-kit.app.service.d4de1dbf`; job loaded in `gui/501` and host parent PID 1 (launchd).
- Disposable data/HOME/Pi agent/project under `~/Library/Caches/pi-kit-macos-service-test-9ef77b2/`.
- The user's normal pi-kit app stayed open and was never attached to the test host. The test always reported `Desktop: not attached`.

### Why the environment-only wrapper exists

The shipped registration persists its data/log folders and PATH, but not a custom HOME or `PI_CODING_AGENT_DIR`. Merely setting those in the installing shell would not isolate a launchd-started backend from the user's normal Pi profile.

The test therefore copied the **unchanged shipped CLI** into a disposable runtime directory. Its `service-host.cjs` is a tiny external wrapper that sets only test HOME, Pi agent directory, and project cwd, then requires the **real, unmodified packaged service host**. A symlink to the original `app.asar` supplies the CLI's packaged version lookup. No signed app files were changed.

All lifecycle commands and registration logic are the actual shipped implementation, using real `launchctl`, not a fake service manager. The extra wrapper is test isolation, not proof that arbitrary shell environment overrides are persisted by the shipped installer. No global `launchctl setenv`, normal Pi configuration changes, real credential copies, or administrative privileges were used.

The spawned backend's native exec environment was checked for the isolated HOME and Pi directory. macOS `ps` records the original exec environment, not a host wrapper's subsequent `setenv`, so the assertion intentionally checks the backend child that inherits those values.

## Executed native tests

| Check | Result |
| --- | --- |
| CLI install and detached healthy startup | PASS |
| Real LaunchAgent: RunAtLoad, unsuccessful-exit KeepAlive, launchd parent | PASS |
| Isolated backend HOME and Pi agent directory | PASS |
| Discovery/socket mode 0600, owned by UID 501 | PASS |
| Idempotent install leaves host PID unchanged | PASS |
| Invalid local RPC authentication closes connection | PASS |
| Unauthenticated backend health/thread requests return 401 | PASS |
| Backend SIGKILL → watchdog replaces backend, retains host | PASS |
| Host SIGKILL → launchd replaces host and starts healthy backend | PASS |
| Duplicate host exits 3 without replacing owner | PASS |
| Clean CLI stop stays stopped beyond launchd throttle interval | PASS |
| CLI start and restart | PASS |
| Uninstall removes both plist and loaded launchd job | PASS |
| Reinstall starts healthy detached service again | PASS |
| Real Tailscale HTTPS gateway on a separate host port | PASS |
| Unpaired browser denied (session and threads 401) | PASS |
| Real browser pairing UI with matching six-digit owner confirmation | PASS |
| Backend identifies itself as darwin/arm64 with isolated agent directory | PASS |
| Real Gemma model tool use writes and verifies a Mac-native file | PASS |
| LaunchAgent restart retains browser approval, thread, onboarding, and model config | PASS |
| Second real model task in the same persisted thread after restart | PASS |
| Paired host SIGKILL → launchd restores gateway and same browser approval | PASS |
| Browser reload renders persisted native transcript, without Welcome reopening | PASS |
| Device revocation immediately denies session/API; remains revoked after restart | PASS |
| Cleanup removes test job/plist/discovery and restores original Tailscale Serve ports | PASS |

## Real model execution

The browser submitted the normal remote AG-UI request to the **Mac's** service. The backend used the already running, authenticated loopback llama.cpp endpoint `http://127.0.0.1:18088/v1`, not `host.docker.internal`. Model: pinned Gemma 4 E2B Q4_0 from LOCAL-MODEL.md.

The native fixture contained numbers `[13, 19, 7]` and a new random proof string not present in the prompt.

### First run

```text
HTTP 200; 206 streamed events; RUN_FINISHED success
Tools: read -> write -> read
Elapsed: 13,011 ms
Model output sum: 39
Random proof and exact JSON keys: independently verified
File owner: UID 501
Model completion output tokens: 17 + 74 + 17 + 79 = 187
```

### After restarting the native LaunchAgent

```text
Same paired browser and thread, no desktop attached
HTTP 200; 159 streamed events; RUN_FINISHED success
Tools: read -> write -> read
Elapsed: 4,300 ms
model-restart-proof.json: same sum/proof, resumed=true
Independent exact-file and UID 501 assertions: passed
Additional model output tokens: 17 + 66 + 19 + 39 = 141
```

The final transcript, tool-call summaries, and responses rendered in the real browser and were inspected with a screenshot after a browser reload. No cloud model or paid provider was used. No shell command was requested of the model.

## Reproduce safely

Use a normal **Node 24+** executable for build tooling. Do not substitute Electron-as-Node for electron-builder's CLI: its argv handling differs. The runtime itself correctly uses Electron-as-Node.

Build a native ARM64 directory package through `scripts/release.mjs --only mac --dir`. If reusing current cross-platform production JS artifacts, `--skip-build` is supported; the Mac-native staging/verification/packaging must still run. Keep this test app separate from `/Applications/pi-kit.app`.

Start the authenticated local model server as documented in LOCAL-MODEL.md if testing inference. The preparation script uses only the disposable key file `/tmp/pi-kit-headless-test/llama-api-key`; it never reads normal provider credentials. Without that file, preparation still works for lifecycle tests but does not configure Gemma.

From the repository root:

```sh
NODE=/path/to/node-24-or-newer
"$NODE" scripts/headless-test/macos-prepare.mjs
/tmp/pi-kit-macos-service-test/pi-kit --version
/tmp/pi-kit-macos-service-test/pi-kit service install
"$NODE" scripts/headless-test/macos-lifecycle.mjs
```

`macos-prepare.mjs` refuses to rewrite a live test profile's runtime. It leaves existing test input/output data intact, so use fresh output filenames or remove only the old disposable outputs for a new independent model run.

The lifecycle suite leaves the isolated service running for remote tests. The actual test data path and hashed service label are in the private `/tmp/pi-kit-macos-service-test/paths.json`.

Use the local administrative test helper without attaching as a desktop:

```sh
export PI_KIT_DATA_DIR="$HOME/Library/Caches/pi-kit-macos-service-test-9ef77b2/data"
# Inspect existing Serve ports first and choose an unused test port.
"$NODE" scripts/headless-test/host-rpc.mjs remote.start 8444
"$NODE" scripts/headless-test/host-rpc.mjs remote.beginPairing
# Open the returned URL, compare confirmation codes, approve using local RPC.
```

Use `model-e2e.browser.js` on the paired origin, passing the native test project as its optional third argument:

```js
headlessModelTest.start(
  '<native-thread-id>',
  '<prompt requiring actual read/write/read of the test fixture, without shell commands>',
  '/Users/<user>/Library/Caches/pi-kit-macos-service-test-9ef77b2/home/project',
);
headlessModelTest.summary();
```

Independent verification, including the follow-up file after native service restart:

```sh
PI_KIT_TEST_PROJECT="$HOME/Library/Caches/pi-kit-macos-service-test-9ef77b2/home/project" \
  "$NODE" scripts/headless-test/verify-model.mjs --restart
```

### Scoped cleanup

Revoke the test device, stop only this profile's remote gateway, and uninstall only its hashed LaunchAgent:

```sh
"$NODE" scripts/headless-test/host-rpc.mjs remote.revokeDevice '"<device-id>"'
"$NODE" scripts/headless-test/host-rpc.mjs remote.stop
/tmp/pi-kit-macos-service-test/pi-kit service uninstall
/tmp/pi-kit-macos-service-test/pi-kit service status
# Expected: not installed; not running; exit code 3.
```

Do **not** log the Mac out of Tailscale, reset all Serve mappings, stop the ordinary pi-kit app, or remove another service label. Keep the cache/profile for inspection, or remove only that explicitly named disposable folder after confirming its job is unloaded.

## End state

Cleanup was actually performed:

- Browser device grant revoked and its persistence checked after service restart (401).
- Native test gateway stopped; host Serve TCP ports returned to the original empty set.
- Test LaunchAgent uninstalled: plist absent, `launchctl print` reports no job, discovery file removed.
- Ordinary `/Applications/pi-kit.app` process remained PID 8438. Normal Pi settings remained 458 bytes with their original 2026-11-05 modification time.
- Docker and llama.cpp were left running at the end of the native-only tests, then stopped during final project cleanup. The Docker test node was logged out and its container/home volume/network removed.
- The disposable native profile and temporary launchers/credentials/logs were removed during final cleanup. Reusable GGUF and Linux release build caches were retained.

## Not tested

No macOS reboot or sign-out was performed. RunAtLoad and real job registration were checked, but sign-in startup after an actual reboot is not claimed. This is the per-user/login service, not a boot-level LaunchDaemon.

Existing encrypted-profile/Touch ID/unattended-key migration, Developer ID signing/notarization, instance-signing-key cold-start behavior, and GUI computer-use/TCC grants were not tested. The fresh isolated profile used the default macOS no-keychain startup policy. The same app identifier/signing identity constraints of a production install were not validated by this ad-hoc build.
