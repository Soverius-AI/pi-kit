# Headless service integration results

Initial tests ran 2026-11-06 against commit **9ef77b2**, `feat/always-on-service`, rebased onto `f47a5c5`. The subsequent onboarding fix below was tested on the same branch on 2026-11-07.

## Environment

- Docker Desktop 4.77.0, Linux ARM64 engine, cgroup v2.
- Packaged Linux directory build, application version 0.10.9.
- Actual runtime: Electron 44.9.0, Node 24.22.0, linux/arm64.
- Fresh unprivileged `tester` user, UID 1001, persistent home volume.
- Real systemd PID 1, systemd user manager, user linger enabled by the test image.
- Tailscale 1.104.5, official static archive verified against its published SHA-256.
- Isolated Tailscale node, userspace networking; remote browser on the host Mac.
- No existing host profile, paid-provider credentials, signing key, Docker socket, or filesystem bind mounts in the runtime container. No desktop was ever attached to the host. The later local-model test added only a newly generated disposable llama.cpp API key.
- Pi-kit used its default fresh Linux storage behavior, without test secret-store overrides. Existing encrypted-profile behavior was not tested.

## Build and installation

The existing Linux Docker release flow built and packaged renderer/backend/desktop/service-host/CLI. Its checks loaded the shipped native modules and ran the shipped PTY implementation successfully.

`pi-kit service install` wrote and enabled the real `dev.pi-kit.app.service.service` user unit. A subsequent status command reported:

```text
Background service: installed (dev.pi-kit.app.service)
Host: running, run by the background service, version 0.10.9
Backend: running
Desktop: not attached
```

Exact PIDs, loopback ports and discovery tokens are deliberately omitted from this report.

## Executed tests

| Check | Result | Evidence |
| --- | --- | --- |
| Fresh, detached service startup | PASS | Backend reported running; desktop never attached |
| Idempotent install | PASS | Host PID unchanged |
| Local discovery/socket protection | PASS | Both mode 0600, owned by tester |
| Invalid local RPC token | PASS | Connection closed without response |
| Backend crash recovery | PASS | SIGKILL replaced backend PID, incremented watchdog restarts, retained host PID |
| Host crash recovery | PASS | SIGKILL replaced host PID through systemd, backend became healthy |
| Duplicate owner | PASS | Second app-level host exited 3, original host remained running |
| Backend unauthenticated APIs | PASS | Health and threads both returned 401 |
| Stop/start/restart | PASS | Clean stop stayed stopped beyond RestartSec; start/restart returned healthy new processes |
| Uninstall/reinstall | PASS | Uninstalled service stopped; reinstall restored healthy detached operation |
| Remote start before Tailscale login | PASS | `disconnected`, `connection-required`, no unauthenticated publication |
| Real tailnet HTTPS | PASS | Remote host reported serving on HTTPS port 8443; browser reached the pairing page |
| Unpaired browser | PASS | `/phone/session` and `/api/threads` returned 401 |
| Pairing approval | PASS | Browser and owner saw matching six-digit confirmation; authenticated local RPC approved the request; real renderer loaded |
| Remote UI operations | PASS | Opened `/home/tester/headless-test-project`, created a thread via normal onboarding UI |
| Remote thread rename | PASS | PATCH returned 200; title changed in live UI without reload |
| Remote execution | PASS | POST thread bash returned NDJSON progress and exitCode 0; command wrote `remote-proof.txt` containing `remote-control-ok` |
| Independent filesystem check | PASS | `docker exec` read the expected file from the project directory |
| Missing/wrong device CSRF bearer | PASS | `/api/threads` returned 401 even with paired browser cookies |
| Forbidden owner administration | PASS | Paired browser PATCH `/api/instance` returned 403 |
| Origin protection | PASS | POST `/phone/pair` with missing Origin or `https://example.com` Origin returned 403 |
| Paired backend crash recovery | PASS | Same browser session and persisted thread returned 200 after backend SIGKILL |
| Paired host crash recovery | PASS | Gateway restored automatically, one saved device, same browser session/thread returned 200 after host SIGKILL |
| Full container restart | PASS | Systemd user service and Tailscale restarted; gateway restored automatically; no desktop/login action needed |
| Browser reload after container restart | PASS | Same browser remained paired; same thread/title returned 200 |
| Revoke device | PASS | Gateway devices became empty; browser redirected to pairing; session and thread requests returned 401 |
| Revocation persistence | PASS | After CLI service restart, zero devices and browser session still 401 |

### Remote execution used no model

The paired browser invoked the real reviewed thread-bash endpoint with:

```sh
printf 'remote-control-ok\n' > remote-proof.txt
printf 'stream-part-1\n'
sleep 1
printf 'stream-part-2\n'
cat remote-proof.txt
```

The response included running frames with partial output and a final frame with `running: false`, `exitCode: 0`, and all expected output. This proves remote shell execution/streaming, **not a model-generated agent turn**. No provider was configured and no paid model request was made.

## Follow-up: real local model execution

The initial run below used no model. A subsequent test closed that gap with **Gemma 4 E2B Q4_0** on a native Mac llama.cpp server, reached by the Docker backend through `host.docker.internal`. The paired browser initiated a real agent run over the normal remote AG-UI endpoint. The model called **read → write → read**, calculated 49, copied a random input proof correctly, and finished successfully in **11.238 seconds**. Independent Docker-side assertions verified the exact generated file and its owner.

After a full container restart, the same thread and provider configuration resumed; another model-driven **read → write → read** task succeeded in **3.512 seconds** and passed independent file assertions. Both runs streamed model usage and tool events and used no desktop attachment or paid provider. The persisted transcript and per-turn usage also rendered in the real remote UI.

See [LOCAL-MODEL.md](./LOCAL-MODEL.md) for the pinned model checksum, server configuration, output/token counts, reproduction steps, and remaining scope limits.

## Original UI gap: onboarding completion (fixed)

After the paired browser used **Finish setup**, reloading showed Welcome again. The browser's authenticated request:

```text
POST /api/setup/state {"state":"completed"}
-> 403 {"error":"Route unavailable on phone"}
```

`libs/onboarding/data/src/lib/onboarding.store.ts` calls this endpoint and swallows the error in `finish()`/`skip()`. In the original build the route was not in the remote allowlist, so normal fresh-browser onboarding could not persist completion remotely.

### Narrow fix and regression checks

`SetupController.state` is now explicitly marked `@Remote()`, with generated OpenAPI/remote routes updated. Only `POST /api/setup/state` was added. Its existing strict DTO accepts `completed` or `skipped`; the handler only records the `onboarding` flag and a server timestamp. No provider configuration, credentials, arbitrary settings, or setup administration was exposed.

After rebuilding and deploying the actual packaged Linux app to the existing test machine:

- The real **Finish setup** button persisted `completed` and disappeared. After a **full container restart and browser reload**, the same timestamp/state remained, the backend was connected, and neither Welcome nor the setup overlay/strip returned.
- The UI's **Skip, take me to the app** button also persisted completion. Separately, the explicit `skipped` API state returned 200 and survived a **service restart and browser reload** without reopening Welcome.
- Invalid state `reset`, an extra `provider` field, and an extra `credentialStoreEnabled` field returned **400**. None changed the saved onboarding flag.
- Local setup test/save, ready, scratch, and authentication/login routes still returned **403** for the paired browser. Missing device CSRF bearer returned **401**. Automated gateway tests also retained cookie and Origin checks.
- Regression suites: **187 protocol tests**, **143 service-host tests**, and **36 backend setup/contract tests** passed. OpenAPI/SDK generation consistency, formatting, and targeted lint checks passed.

The default behavior that completed onboarding may reopen when no usable model remains is unchanged; the test profile had its real Gemma provider configured. This fix addresses completion persistence, not remote provider administration.

## Scope limits

- Shipped CLI has no remote/pairing subcommands. A small allowlisted local test client issued the existing authenticated host RPC calls. It never called `attach` or supplied fake sealing. The run therefore does not establish a complete shipped headless onboarding UX.
- Browser/phone device pairing does not use the instance-signing key. Instance-to-instance pairing/signing is a separate path; code inspection indicates cold-start signing still needs desktop-backed sealing. That path was **not** claimed as tested.
- Linger was configured by the test image. Container restart demonstrates an already-enrolled user service, not a pi-kit boot-level enrollment command or physical reboot.
- The unpacked packaged runtime was tested, not AppImage mount/FUSE/launcher behavior.
- The initial run used no model; the follow-up above tested a real local model. A later **native macOS** run also passed real LaunchAgent lifecycle/crash recovery, remote pairing, and model tool use before/after restart; see [MACOS.md](./MACOS.md). Cloud-provider authentication, GUI computer-use, protected credential restart, and Windows service registration remain untested.
- Docker Desktop required privileged container mode for writable cgroups. This is not a recommended production deployment. Pi-kit processes still ran as the unprivileged user; the container had no host binds/socket.

## End state

The services and model were initially left running for inspection. After testing, the native Mac job/gateway were uninstalled, the Docker test node was logged out, its container/home volume/network were removed, and the test llama.cpp server was stopped. Disposable Mac profile data and temporary credentials/logs were removed. The normal pi-kit app and unrelated Docker workloads were not touched. The downloaded GGUF and reusable Linux release build/cache volumes were retained. Reproduction and scoped cleanup instructions are in README.md, LOCAL-MODEL.md, and MACOS.md.
