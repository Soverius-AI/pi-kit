# The pi-kit server: one server, a thin desktop shell, any browser

Status: Proposed
Date: 2026-11-07

pi-kit becomes a server first. The desktop installers and a server tarball ship the same server, each with its own
runtime; Electron is a window onto it, and a local browser or a paired phone is another client of the same web app.
This replaces the separate headless distribution that [ADR-0036](../docs/adr/0036-always-on-service.md) §7 step 6
planned, and becomes ADR-0037 when accepted.

## Context

- **What runs where today.** The service host (ADR-0036) runs the backend on loopback with a token and hosts the remote
  gateway. Electron serves the renderer on `app://pi-kit` (`apps/desktop/src/app-protocol.ts`) and hands it the
  backend's URL and token through preload (ADR-0007). The gateway serves the same renderer to paired devices with a
  cookie session and a per-load CSRF token (`/phone/session`), forwarding only `@Remote()` routes (ADR-0035).
- **The server already runs without Electron.** On 9ef77b2 the packaged Linux build ran under systemd with no desktop
  attached: lifecycle and crash recovery, Tailscale publication, browser pairing, a real model's tool calls, and
  revocation that survives a restart ([results](../../scripts/headless-test/RESULTS.md)).
- **What still ties it to Electron:**
  - only Electron can open the full UI: it serves the renderer from `app.asar` and hands the backend token to page
    JavaScript, and a browser on the same machine has no way in;
  - the instance key is sealed through the attached desktop's `safeStorage` (`seal.*` calls in `service-host.ts`), so
    instance-to-instance pairing needs a desktop;
  - on Windows the background service is the Electron binary as a windowless supervisor (`superviseHost` in desktop
    main), because `node.exe` opens a console window;
  - the CLI has no remote, pairing, sign-in or peer commands.
- **Requirements:** a server install and the desktop app are the same product and can live on one machine; neither
  runs on a Node.js the user installed; the installers and their updater stay the desktop channel; Linux, macOS and
  Windows are supported from the first release; instance-to-instance pairing works without a desktop.

## Decision

**The server is the product; every UI is a client of its gateway.** No new library, no new architectural layer: the
host, backend, gateway and renderer stay as they are. The work is a front door for browsers at the gateway, the token
out of the desktop page, and the instance key's seal moved from Electron to the host.

```text
pi-kit server  (the server tarball; the desktop app bundles the same files)
  host ── backend          loopback, token: only the host, Electron main and the CLI hold it
   └── gateway ── owner listener   127.0.0.1:<port>   owner session: every route
               └── device listener → tailscale serve   device session: @Remote() routes

Electron window ──> backend directly; Electron adds the token outside the page
local browser ──> owner listener
phone, other computer on the tailnet ──> device listener
other pi-kit instance ──> device listener, signed with its instance key
```

### §1 The server and how it ships

The server is one folder: the `backend/` that `scripts/package-stage.mjs` already stages per target (`main.js`,
`service-host.cjs`, `pi-kit.cjs`, `pi-kit-secret.cjs`, the natives) with `renderer/browser/` beside it. The renderer
leaves `app.asar`. The host takes the web app and its version from its own install, so a service unit carries only the
data folder, the log folder and PATH, and an upgrade leaves it unchanged. **Nothing runs on a Node.js the user
installed**: every install carries its own runtime.

- **Installers, for desktops, from the first release.** The dmg and zip on macOS, the AppImage on Linux and the NSIS
  installer on Windows stay, published to GitHub releases as today. They carry the server folder as
  `Resources/backend` and `Resources/renderer` and run it on Electron's Node. electron-updater updates the shell and
  its bundled server together, and the app restarts the host when it runs from that install.
- **The server tarball, for machines without a desktop.** One archive per target, `pi-kit-server-<version>-<target>`
  (`.tar.gz`, `.zip` on Windows), for all six targets in `scripts/natives.mjs`. It holds the server folder, a pinned
  Node 24 runtime (`runtime/`, the official binary, checked against its published SHA-256 as `scripts/natives.mjs`
  checks the natives), a `package.json` with the version, and `bin/pi-kit` (`bin\pi-kit.cmd` on Windows), which runs
  `backend/pi-kit.cjs` on that runtime. It unpacks anywhere, needs no installed Node, and needs none of the GUI
  libraries the Electron binary loads even as Node (the headless test image installs `libgtk-3-0`, `libnss3`,
  `libasound2` and more). The natives are N-API, so the binaries the desktop stages load under that runtime.
- **npm, the same server for a terminal.** `npm install -g @soverius-ai/pi-kit` gives the `pi-kit` command on all six
  targets. `@soverius-ai/pi-kit` is a launcher; its optional dependencies are one package per target,
  `@soverius-ai/pi-kit-<target>`, each the server tarball of that target unpacked as it is, with `os` and `cpu` so that
  npm installs only the machine's own. The launcher runs on the user's Node only to start that package's
  `backend/pi-kit.cjs` on the package's own runtime, so the service never depends on the Node that installed it
  (`scripts/package-npm.mjs`, `scripts/npm/`).
- **One release.** Each version publishes the installers, the server tarballs and the npm packages from the same CI
  run, with the tarballs' checksums, so every server version has a matching desktop app (§3).
- **`pi-kit update`** in a server install fetches the release's tarball for its target, checks its SHA-256, stops the
  service, replaces the install and starts the service again. In a desktop install it says to update from the app; in
  an npm install it gives the npm command, with the service stopped around it, since npm owns that folder. On
  Windows, where the running `node.exe` cannot be renamed, a finisher makes the swap: a copy of the runtime and CLI
  beside the download, started through WMI so that a closing SSH session does not end it. It waits for the command to
  exit, swaps (putting the old install back when that fails), starts the service again and removes the download.

### §2 Front doors

- **The desktop window takes no extra hop.** Electron serves the running server's web app on `app://pi-kit`; the
  folder comes in the `attach` answer, so the UI is always the server's own version. The page calls the backend
  directly, as today. Electron adds the bearer token in its network layer (`session.webRequest.onBeforeSendHeaders`)
  only to requests from the app window to the backend's origin whose `Origin` is `app://pi-kit`. That rule matters: the
  MCP app and GenUI sandboxes run inside the window as frames served from the backend's origin
  (`/api/mcp-sandbox/proxy.html`, `genui-sandbox.controller.ts`), and today the missing token is what keeps them out of
  the backend. Their requests carry no `Origin` or `null`, so they still get none. The embedded browser has its own
  session. The token leaves page JavaScript, where preload puts it today; the renderer's four places that set the
  header (`backend.service.ts`, `entry-api-client.ts`, `app.config.ts`, `main.ts`) stop doing so on the desktop.
- **Two gateway listeners.** A plain browser cannot add a header, so it needs a session, and that is the only place
  the gateway's proxy hop exists; phones have it today. Tailscale Serve connects from loopback (the gateway refuses
  anything else, `remote-gateway.ts`), so one listener cannot tell a phone from a local browser. The gateway gets a
  second, **owner** listener, never published, for a browser on the machine or one reaching it through an SSH forward.
  It listens on loopback port 47800, or on a free port when 47800 is taken, and keeps that port in the profile so links
  and bookmarks keep working. Development and scratch profiles always take a free port. It accepts only
  `Host: localhost` or `127.0.0.1`, which stops DNS rebinding. The **device** listener is today's, behind
  `tailscale serve`.
- **Owner sessions.** A connection that holds the host token (the owner-only discovery file and socket, ADR-0036 §2)
  asks the host for a one-time link, `http://127.0.0.1:<port>/#owner=<code>`. The page trades the code once for a
  bearer token kept in its own origin's storage. A cookie would not do: cookies are not scoped by port, so one for
  127.0.0.1 would reach every other local server the browser visits. The host keeps only the tokens' hashes, in an
  owner-only `owner.json`, and `pi-kit open --revoke` signs every browser out. An owner token passes every backend
  route and means nothing on the device listener, which keeps the `@Remote()` allowlist.
- **Three renderer transports.** The desktop transport calls the backend directly and no longer reads a token. Phones
  keep their same-origin cookie and CSRF token; the owner's browser sends its bearer token
  (`createBackendConnection` in `libs/shared/api/src/lib/backend.service.ts`). The page marker the gateways inject
  (`pi-kit-connection`) gains `owner` beside `device`, so the owner's browser gets the full UI, provider sign-in
  included. Every client gets the web app from the running server, so UI and backend cannot drift apart.
- **`pi-kit open`** starts the desktop app when it is installed and focuses it when it runs; otherwise it opens the
  default browser on a fresh link. Over SSH it prints the link with an `ssh -L` forward for the owner port.

### §3 Electron is a shell

- **Start**: find a running host; otherwise start the registered service; otherwise start the bundled server as its
  own child (ADR-0036's app-owned mode). Attach, which returns the backend's endpoint as today and now also the
  server's web app folder, then serve that folder and open the window.
- **The shell and the server always have the same version**, so the desktop always has every feature. On start the
  shell compares the running server's version with its bundled server's:
  - **Same**: attach.
  - **The running server is older**: restart the host onto the bundled server, as ADR-0036 §2 does today, and register
    the desktop install as the service when the older one was registered (§5).
  - **The running server is newer** (a server install updated first): electron-updater fetches and installs that
    release, or a newer one, before the shell attaches (`AppUpdater.updateTo`). The splash says it is updating to match
    the service. Both channels ship from one release (§1), so that version exists.
  - **No shell of that version answers** (no network within 15 seconds, or a server built from a branch): the shell
    attaches as it is. This is the only case with a missing feature, and the bridge rule below keeps it from failing.
- **The bridge only grows.** A new backend request to the desktop is optional for the server, and an existing one never
  changes meaning. An older shell answers a request it does not know as a host without a desktop does ("needs the
  desktop app"), so nothing waits. A new preload method is optional in the bridge type, so the UI checks for it and
  says to update the app where it is missing.
- **What stays native**: the embedded browser, open and reveal path, app update, tray, notifications and microphone
  permission, all through the existing `DesktopBridge` (`browser`, `openPath`, `revealPath`, `appUpdate`). In a plain
  browser they answer "needs the desktop app", as they already do on a phone. Computer use still needs a signed-in
  desktop session.
- A single-instance lock, which the app lacks today, so a second launch and `pi-kit open` focus the open window.
- **Updates**: electron-updater, as in §1.

### §4 The instance key is sealed by the host

- The host implements `InstanceKeyEncryption` itself: a random wrapping key in the OS credential store through
  `@napi-rs/keyring` (already in the server's natives), and the key file sealed with it (AES-256-GCM). That is
  Credential Manager on Windows, the login keychain on macOS and the Secret Service on Linux.
- **No usable store** (a Linux server without a Secret Service, a Mac nobody has signed in to): the owner can explicitly
  turn on an owner-only key file outside the data folder, like an SSH key, and the CLI says that file permissions are
  the protection. It is never chosen automatically; without it instance pairing stays unavailable.
- **macOS**: a login keychain item belongs to the binary that made it, so the wrapping key belongs to the runtime that
  runs the registered service. Switching installs (§5) happens while someone is signed in: macOS asks once, and
  `service install` says so beforehand. A Mac nobody signs in to uses the file opt-in anyway.
- **Migration**: a key Electron sealed is re-sealed once by the host while a desktop is attached: the desktop unseals,
  the host seals, and the old file stays until the new one reads back. ADR-0035's rule holds: no identity is ever
  silently regenerated.
- Instance pairing then works with no desktop. The CLI gets `pi-kit peers`, `peers invite`, `peers connect
  <invitation>`, `peers approve|reject <request>` and `peers unpair <peer>` on the existing routes in
  `apps/backend/src/peers/peers.controller.ts`.
- Provider keys and the database key follow ADR-0019 unchanged. The Touch ID store needs the signed desktop app's
  helper, so a Mac with only the server install has the other ADR-0019 choices.

### §5 One registration, whichever install made it

- One data folder, one host and one service name per profile, as today. **The newest install runs.** `pi-kit service
  install`, `pi-kit update` and the desktop's Background switch register their own install only when it is at least as
  new as the registered one, and then remove the other's registration. Otherwise they name the newer install that runs
  and change nothing. The desktop applies the same rule at every start (§3). If the registered install disappears, the
  other one registers itself at its next start. `service status` names the install, path and version that runs, and
  every other command talks to whichever host runs. No install ever runs a profile that a newer one has migrated.
- **Linux**: the systemd user unit; starting at boot with linger, whose command `service install` prints when it is off.
- **macOS**: the LaunchAgent while someone is signed in. Starting at boot with nobody signed in: a LaunchDaemon in
  `/Library/LaunchDaemons` with `UserName` set to the owner, never root, installed once with `sudo`. The login keychain
  is locked there, so the instance key needs the file opt-in of §4. The newest install runs there too: `service install
  --level boot` refuses an older install, and the desktop, which cannot change a root-owned daemon, only becomes the
  newer version the daemon runs first.
- **Windows**: the desktop keeps its sign-in entry and windowless supervisor. A server install, whose `node.exe` would
  open a console window from a sign-in entry, registers a Task Scheduler task that starts at boot, runs whether the
  owner is signed in or not, restarts on failure, and shows no window; Task Scheduler stores the account password, so
  Credential Manager works.
- **`pi-kit serve`** runs the host in the foreground on all three, for containers and other supervisors: a third host
  level that starts the backend at once and writes its output to the terminal. With another host on the data folder it
  exits with 3.
- **Upgrade**: electron-updater for a desktop install and `pi-kit update` for a server install (§1); each updates only
  its own install. The unit names a path that stays the same across versions, and `service status` flags a host whose
  version differs from the CLI's.

### §6 The CLI

The CLI is a client of two existing interfaces and repeats no business rule.

| Command | Calls |
| --- | --- |
| `pi-kit service …`, `serve` | the service manager and host lifecycle, as today |
| `pi-kit update` | server install: the release's tarball and checksum, then `service stop`, replace, `service start`; npm install: the npm command; desktop install: points to the app |
| `pi-kit open` | host: owner link; launches the desktop app or a browser |
| `pi-kit remote status\|enable\|disable` | host: `remote.status`, `remote.start` (prints `remote.setupUrl` when Serve needs approval), `remote.stop` |
| `pi-kit pair`, `pi-kit devices [approve\|reject\|revoke]` | host: `remote.beginPairing`, `remote.status`, `remote.approvePairing`, `remote.rejectPairing`, `remote.revokeDevice` |
| `pi-kit login [<provider>]`, `login --local <url>`, `logout`, `model` | backend: `pi-settings`, `auth/login` and its events and answers, `setup/local/test` and `save`, `auth/logout` |
| `pi-kit peers …` | backend: the peer routes (§4) |

- Backend calls go through a new host RPC method, `backend`, that returns `{ url, token }` to a connection holding the
  host token. That grants nothing new: the same connection can already call `attach`, which returns the endpoint but
  makes the caller the desktop. The client is the generated one (`libs/shared/api/src/generated`), imported through a
  `@pi-kit/api/generated` entry without the Angular half.
- `pair` prints the link and a QR code (`qrcode`, already a dependency), shows each request's name and confirmation
  code, and never approves on its own. `login` reads keys and pasted codes with a masked prompt; an OAuth provider that
  redirects to `localhost` finishes over SSH through pi's `manual_code` prompt.
- Setup over SSH is four commands: `service install`, `login`, `remote enable`, `pair`. On a desktop it is opening the
  app.

### §7 Security

- ADR-0007's threats are other users and web pages. Another user can reach the owner port but cannot get a token
  without the owner-only host token. A web page is stopped by the `Host` and `Origin` checks and by a token it cannot
  read from another origin's storage.
- The backend token never reaches page JavaScript, a browser or a device; only the host, Electron main and the CLI hold
  it.
- ADR-0035 is unchanged for devices: the `@Remote()` allowlist, expiring pairing codes, confirmation codes, and
  revocation that survives a restart. Owner sessions never exist on the device listener.

## What this changes in other records

- **ADR-0007**: the desktop page no longer holds the backend token; Electron adds it to the window's requests. A browser
  on the machine reaches the backend through the gateway with an owner session.
- **ADR-0035**: the host gains an owner listener beside the device gateway; the instance key is sealed by the host.
- **ADR-0036**: the desktop becomes a client of the server; the renderer moves out of `app.asar` into the server
  folder, which Electron serves from the running server; the newest installed server runs, and an older shell updates
  itself before attaching; adds the `backend` RPC, the `serve` level, and server-install registration on macOS and
  Windows;
  this record replaces §7 step 6.
- **ADR-0019 and ADR-0034**: no change. The CLI and every UI use the existing HTTP contract, so nothing in
  `apps/backend` moves.

## Not in this design

- New `libs/server/*` libraries or per-capability `domain/application/ports/infrastructure` layers: ADR-0034 settles
  the structure.
- A setup wizard, `doctor`, `config get/set`, `--json` envelopes and an exit-code taxonomy beyond `service status`'s 3.
- Opening or revealing files from a plain browser: these stay desktop features.
- A service worker, offline mode and a native-app pairing protocol.

## Order of work

1. Host-side instance-key sealing with migration, and `pi-kit peers`. Instance pairing works headless.
2. The owner listener, owner sessions, one-time links and `pi-kit open`. A local browser works against today's server.
3. Electron serves the running server's web app and adds the token in its network layer instead of handing it to the
   page; single-instance lock; the shell never moves a newer host back onto its own version.
4. The server folder as the one artifact: the renderer leaves `app.asar`, the desktop bundles the folder, the server
   tarball is written from it with its pinned runtime, and the host derives the web app and version from it. The rest
   of §3's version rule: the shell updates itself before attaching, and answers unknown bridge requests.
5. The remaining CLI: `backend` RPC, `remote`, `pair`, `devices`, `login`, `logout`, `model`, `serve`;
   `host-rpc.mjs` is deleted.
6. Registration for server installs, and `pi-kit update`: Linux user unit and linger, macOS LaunchAgent and
   LaunchDaemon, Windows scheduled task, and "the newest install runs".
7. Release: the installers as today and the server tarballs, with their checksums, from the same CI run.
8. npm: the launcher and one package per target, written from that run's server tarballs, installed and run on every
   release run and published on a tag.

## Verification

Linux x64 and arm64 in the headless Docker test from the server tarball, on an image with no Node installed; macOS and
Windows on real machines:

1. Unpack the server tarball, then `bin/pi-kit service install`: status names the server install, backend running, no
   desktop, and no `node` on PATH.
2. `pi-kit login --local` against a local model server; `pi-kit login` with a dummy API key (masked, says where the key
   went, fails the key check cleanly).
3. `pi-kit open`: the full UI in a local browser, provider settings included. A page from another origin, a wrong
   `Host` and a missing token are all refused.
4. The desktop app installed beside it, in three cases:
   - At the same version, it attaches to the running server install.
   - Newer than the server install, it restarts the host onto its own server and takes over the registration; a later
     `pi-kit service install` from the older server install changes nothing and names the desktop install.
   - Older than the server install, it updates itself to that version before attaching. Offline, it attaches and marks
     the native features it lacks.

   In every case its requests go straight to the backend, page JavaScript holds no token, an MCP app or GenUI sandbox
   frame gets 401 from the backend, and closing the window leaves the server running. The e2e suite, its
   `*.desktop.e2e.mjs` specs included, passes unchanged: the desktop keeps every feature it has today.
5. `remote enable` and `pair` a phone: it reaches only `@Remote()` routes, and an owner token means nothing on the
   device listener.
6. Two servers with no desktop attached (the Linux container and a Mac) pair through `pi-kit peers`; one opens a
   project on the other; both restart and still sign.
7. Restart or reboot per platform: the service, publication, devices and peers come back.
8. Revoke the device and unpair the peer; both stay revoked after a restart.
9. `pi-kit update` to the next version: the unit is unchanged, and the new version is reported and served. The
   desktop app's updater does the same for a desktop install and restarts the host on the new version.
10. Upgrading an existing desktop profile re-seals its instance key, and its existing peers still verify.

## Alternatives considered

- **Instance key with no usable OS store.** `systemd-creds` would need systemd 256 or newer, which Ubuntu 24.04 does
  not have, so most Linux servers would get no instance pairing; requiring the OS store has the same effect. The
  opt-in key file gives them pairing with the protection an SSH key has, stated plainly.
- **Windows background for server installs.** A Windows Service needs a shipped wrapper such as WinSW, administrator
  approval and the password; `pi-kit serve` alone leaves supervision to the user. The scheduled task needs no extra
  binary.
- **macOS boot.** Supporting only signed-in Macs would leave a Mac mini without auto-login unable to start pi-kit after
  a reboot.
- **An npm package on the user's Node.** Half the size, but the service would run on a Node the user installs and
  changes (nvm, upgrades) underneath it. The npm packages carry the tarball's runtime instead.
- **One npm package that downloads the server tarball on first run.** Small to publish, but the first run needs GitHub,
  and npm's lockfiles, integrity checks and mirrors would not cover the server.
- **A Linux server on the AppImage, or the Electron binary as the tarball's runtime.** Both need GTK, NSS and audio
  libraries on a machine with no display, and the AppImage needs FUSE; the tarball's Node runtime needs none of them.
- **A wrapping key per runtime on macOS.** Keeping one sealed copy per runtime would avoid the one prompt when a
  profile switches installs, at the cost of two copies of the identity to keep in step.
