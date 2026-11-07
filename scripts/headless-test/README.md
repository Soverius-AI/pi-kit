# Packaged Linux headless-service integration test

This is an isolated Docker test machine, **not a production server image**. It exercises the packaged Electron binary in Node mode and real systemd user registration. No desktop attachment or fake sealing/key store is used.

For the separate **native macOS LaunchAgent test**, see [MACOS.md](./MACOS.md). That run used the Mac directly, including native crash recovery, real model tool use, remote pairing, and scoped cleanup.

## Build

From the repository root on an ARM64 Docker host:

```sh
node scripts/release-linux-docker.mjs --arch arm64 --dir
docker build --platform linux/arm64 -t pi-kit-headless-test:arm64 scripts/headless-test
```

The release command copies the source read-only into a Docker build volume, installs Linux dependencies, builds the applications, packages them, and verifies native modules. It does not use the Mac's `node_modules`.

If Docker's credential helper hangs on a public image, an empty **temporary** `DOCKER_CONFIG` with `DOCKER_HOST` pointing at the existing Docker context avoids accessing that helper. Do not change or delete the user's normal Docker credentials.

## Boot the test machine

```sh
docker network create --label pi-kit.test=headless pi-kit-headless-test-net
docker volume create --label pi-kit.test=headless pi-kit-headless-test-home
docker run -d --name pi-kit-headless-test-9ef77b2 \
  --label pi-kit.test=headless --network pi-kit-headless-test-net \
  --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --mount source=pi-kit-headless-test-home,target=/home/tester \
  --memory 1g --cpus 2 -e SYSTEMD_LOG_TARGET=console \
  pi-kit-headless-test:arm64
```

Docker Desktop required `--privileged` for writable cgroups: the narrower `SYS_ADMIN` + unconfined seccomp attempt exited before systemd could boot. There are **no host filesystem/cgroup bind mounts, host networking, or Docker socket mounts**. Pi-kit itself runs as `tester` (UID 1001), not root. Do not put real provider credentials or untrusted workloads in this privileged integration-test machine.

The image enables linger for the test user so its real systemd user manager starts without a graphical/login session. This is test infrastructure, **not evidence that pi-kit's unimplemented boot-level installer works**.

```sh
C=pi-kit-headless-test-9ef77b2
docker exec "$C" systemctl is-system-running
docker exec "$C" systemctl status user@1001.service --no-pager
docker cp dist/release/linux-arm64-unpacked/. "$C":/opt/pi-kit/
docker cp scripts/headless-test/host-rpc.mjs "$C":/opt/host-rpc.mjs
docker cp scripts/headless-test/lifecycle.mjs "$C":/opt/lifecycle.mjs
```

Create `/usr/local/bin/pi-kit` inside the container, mode 0755:

```sh
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec /opt/pi-kit/pi-kit /opt/pi-kit/resources/backend/pi-kit.cjs "$@"
```

Define a host-shell convenience function:

```sh
testuser() {
  docker exec --user tester -e HOME=/home/tester \
    -e XDG_RUNTIME_DIR=/run/user/1001 \
    -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
    pi-kit-headless-test-9ef77b2 "$@"
}
testuser pi-kit --version
testuser pi-kit service install
testuser pi-kit service status
testuser node /opt/lifecycle.mjs
```

The lifecycle suite kills the test user's backend and service host, tests recovery and authentication, and exercises stop/start/restart/uninstall/reinstall. It leaves the service running. Do not point it at a real user profile.

## Tailscale and browser pairing

Install official Linux ARM64 `tailscale` and `tailscaled` binaries into `/usr/local/bin` **inside the container**. Verify the archive against the SHA-256 published alongside it at `https://pkgs.tailscale.com/stable/` before extracting it. The tested version is 1.104.5. Do not copy the Mac's Tailscale state or credentials.

```sh
docker cp scripts/headless-test/tailscaled.service "$C":/etc/systemd/system/tailscaled.service
docker exec "$C" systemctl daemon-reload
docker exec "$C" systemctl enable --now tailscaled
docker exec "$C" tailscale up --hostname=pi-kit-headless-test \
  --operator=tester --accept-dns=false --timeout=5s
```

Authorize the generated URL on the same test tailnet as the remote browser's machine. Tailscale Serve requires tailnet HTTPS support and permitted node access. The daemon uses userspace networking, not a host TUN device.

```sh
testuser node /opt/host-rpc.mjs remote.start
testuser node /opt/host-rpc.mjs remote.beginPairing
# Open the returned pairing URL in a fresh browser context.
testuser node /opt/host-rpc.mjs remote.status
# Compare the confirmation code shown in the browser with the pending request.
testuser node /opt/host-rpc.mjs remote.approvePairing '"REQUEST_ID"'
```

`host-rpc.mjs` is an allowlisted **local administrative test helper** because the shipped CLI lacks remote/pairing commands. It reads the existing owner-only discovery file, authenticates over the Unix socket, and never calls `attach`, returns a backend token, or emulates desktop encryption. Keep output private: pairing responses contain short-lived pairing codes. Using this helper demonstrates the host RPC, not a complete shipped headless onboarding UX.

After pairing, verify the actual renderer, remote thread operations, streaming updates, persistence across backend/host/container restarts, and revocation. Instance-to-instance signed pairing is distinct from browser-device pairing and currently requires desktop-backed instance-key sealing.

## Results (base commit 9ef77b2, including the onboarding fix)

- PASS: Linux ARM64 release packaging and native module verification.
- PASS: real systemd user manager; CLI install; backend running with `Desktop: not attached`.
- PASS: all lifecycle checks above, including watchdog and systemd crash recovery.
- PASS: remote start before Tailscale login reports `disconnected / connection-required`.
- PASS: real Tailscale HTTPS access; browser pairing with matching confirmation codes and local RPC approval.
- PASS: remote UI project/thread creation, thread rename, live UI update, shell execution with streamed output, and file creation verified inside the container.
- PASS: the same browser approval and thread survive backend SIGKILL, host SIGKILL, full container restart, and browser reload.
- PASS: device revocation immediately redirects the browser to pairing, returns 401, and remains revoked after service restart.
- PASS: missing/incorrect device bearer tokens, prohibited administration routes, and missing/foreign Origin are rejected.
- FIXED: only `POST /api/setup/state` is now explicitly remote-reviewed. Real UI completion survives a full container restart and browser reload; skipped state also persists. All provider/credential setup remains blocked, and malformed completion bodies are rejected.
- PASS (follow-up): real Gemma 4 E2B inference on the Mac via llama.cpp; model-driven read/write/read tool execution in Docker, exact file assertions, and a second model turn after full container restart.
- PASS (separate native run): macOS LaunchAgent install/lifecycle, watchdog and launchd crash recovery, browser pairing, model tool use before/after restart, and revocation/cleanup. See MACOS.md.
- NOT TESTED: cloud-provider authentication, desktop computer-use, Windows service registration, physical reboot/sign-out, AppImage launcher/FUSE path, or protected-credential unattended restart.

See [RESULTS.md](./RESULTS.md) for the initial run and [LOCAL-MODEL.md](./LOCAL-MODEL.md) for real-model results, setup, and cleanup.

A fresh Linux profile booted without test overrides or a Secret Service daemon. This proves the fresh/default path only, not unattended availability of existing protected credentials.

## Cleanup

The recorded test run has been cleaned up: the test Docker container/home volume/network and native Mac profile were removed, temporary credentials/logs were deleted, and the test llama.cpp process was stopped. The native LaunchAgent and host Serve mapping had already been removed. The downloaded GGUF and reusable Linux release build/cache volumes were retained.

For future runs, only remove this test's resources; never run a global Docker prune.

```sh
docker exec pi-kit-headless-test-9ef77b2 tailscale logout
docker stop -t 30 pi-kit-headless-test-9ef77b2
docker rm pi-kit-headless-test-9ef77b2
# Destructive: removes only the disposable profile and its pairing grants.
docker volume rm pi-kit-headless-test-home
docker network rm pi-kit-headless-test-net
```

Also delete the test node from the Tailscale admin console. The existing Linux release build/cache volumes and images may be retained for subsequent builds.
