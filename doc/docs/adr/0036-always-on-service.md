# ADR-0036: A shared service host: the backend outlives the window

Status: Accepted
Date: 2026-11-05

## Context

Tying the backend to Electron's lifetime pauses background agents and removes phone access when the desktop quits.
The backend, its watchdog and the remote gateway do not require a window; embedded native browser views, native file
dialogs and desktop app updates require an attached desktop. Desktop and server installs need the same ownership, discovery and restart behaviour without making Electron
part of the backend or exposing its loopback token to browsers.

## Decision

- **One host implementation.** `libs/shared/service-host` owns backend supervision, the local host channel, discovery,
  owner-browser access, remote access and instance-key sealing. `apps/desktop/src/service-host.ts` is the Node entry,
  packaged as `service-host.cjs` beside the backend. Desktop installs run it on Electron with `ELECTRON_RUN_AS_NODE=1`;
  server installs use their bundled Node runtime. `apps/cli` uses the same library rather than a second service stack.
- **One profile owner.** The host claims the profile's socket before opening gateways. A listening owner is not replaced;
  a dead Unix socket can be reclaimed. `<dataDir>/service.json`, written with mode 0600, advertises PID, version, install,
  host level, socket and a fresh host token. This socket-based claim is not a database-wide cross-process lock.
- **Separate host and backend credentials.** Newline-delimited JSON RPC over a Unix socket or Windows named pipe requires
  a token hello. Unix sockets are owner-only; Windows pipes permit local connections and rely on the token for
  authentication. Status calls do not attach a desktop or disclose the backend token. An attached desktop receives the
  backend connection and answers desktop-only requests; detached requests receive explicit fallback answers.
- **Lifetime is an owner choice.** `app` hosts end with the desktop, `login` hosts belong to the OS registration, and
  `serve` hosts run under `pi-kit serve` in a terminal or another supervisor. The host's watchdog restarts the backend;
  the OS registration or Windows supervisor restarts the host after failure. Settings › General › Background and
  `pi-kit service install`, `uninstall`, `start`, `stop`, `restart`, `status` and `logs` share service specifications.
  The CLI refuses to stop an app-owned host; a non-running status exits with code 3.
- **Use native registrations.** macOS uses a LaunchAgent, or an explicitly installed LaunchDaemon with `UserName` set
  to the owner (`--level boot`, privileged installation). Linux uses a systemd user unit; boot operation depends on
  linger being enabled. Windows desktop installs use the user's Run key and a windowless supervisor; server installs
  use Task Scheduler under the owner's account, with its password supplied at registration. Registration privileges do
  not add a separate privileged agent layer; the host runs under the configured account.
- **Installs share the profile.** Service specifications identify the runtime, entry, environment and profile. The CLI
  preserves a newer registered install; the desktop updates first when a newer version owns the service, attaches to a
  matching registration, or registers itself. Development profiles have distinct registration names.
- **Clients do not own the backend.** The owner gateway exchanges a one-time browser link for a distinct owner bearer token. The remote
  gateway publishes only allowlisted routes through Tailscale Serve. Instance identity is AES-256-GCM sealed with an
  OS-store wrapping key or an explicitly enabled owner-only key file; legacy Electron-sealed keys can migrate through an
  attached desktop. Electron remains responsible for native browser views, desktop UI and app updates.
- **Power follows work.** The host observes thread and agent activity and requests idle-sleep inhibition while work is
  active, releasing it when idle or stopped. Missing platform commands are logged; this does not override explicit sleep.

## Consequences

- Closing the desktop can leave agents, phone access and spending active when a service owns the profile. Stopping the
  host pauses durable work; reopening its storage resumes unfinished agents.
- Host discovery puts an authentication token on disk for the host's lifetime. Profile permissions remain a security
  boundary; a local browser receives its own owner bearer token, not the host token or backend token. The owner-state file stores session token hashes.
- Headless operation cannot supply desktop-only capabilities. OS credential-store availability still limits unattended
  startup: in particular, a macOS login keychain can be locked before sign-in. Touch ID stores have an explicit
  unattended-copy option, not a silent plaintext fallback. Disk encryption can also require a person after reboot.
- Platform registration code expresses launch behaviour, not a guarantee that every OS, desktop session, packaging format
  or permission configuration supports unattended use. Service operation and credential access are separate concerns.
