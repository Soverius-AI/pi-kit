# ADR-0036: An always-on service: the backend outlives the window

Status: Proposed
Date: 2026-11-05

## Context

Electron main spawns the backend as a child with a per-launch port and token (ADR-0007); a parent-PID monitor stops it
when the app goes, and `window-all-closed` quits the app. Background agents pause on quit (ADR-0033). Remote access is a
gateway in Electron main plus a foreground `tailscale serve` (ADR-0035: "remote control of a desktop, not a service").
An assistant that answers from a phone, runs on a schedule and finishes work overnight needs the backend running with
no window open, on macOS, Windows and Linux; on a home server or a Mac mini it must also come back after a reboot with
nobody signed in.

What is already free of Electron: `watchdog.ts`, `log.ts`, `shell-env.ts`, `remote-access.ts`, `remote-gateway*.ts`,
`tailscale-cli.ts`, `instance-key.ts` (its encryption is injected). What is bound to it: the `DesktopBridge` over the
child's IPC channel (browser artifacts, open and reveal path, instance-key signing through `safeStorage`, app update),
windows, tray, microphone permission and the screenshot encoder.

Constraints: one process owns a data folder (the bg-agents owner lock exists, the main database and session files have
none); loopback with a token; credential reads are deliberate, and macOS keychain items carry a user-presence access
control that nobody answers at 3 a.m.; native modules are N-API prebuilds (`scripts/natives.mjs`). Before anyone signs
in, the macOS login keychain is locked, Linux has no Secret Service session and a Windows process outside the user's
logon has no access to their DPAPI keys.

## Decision

### §1 Three roles

- **Service host** (`libs/shared/service-host`, plain Node, no Nest; its entry `apps/desktop/src/service-host.ts` is
  built with the desktop app and packaged beside the backend as `Resources/backend/service-host.cjs`, a real file a
  service manager can start): runs the backend as its child under the existing
  `BackendWatchdog`, owns the data folder (§2), hosts the remote gateway and the foreground `tailscale serve`, holds the
  instance key and writes `service.log` and `backend.log` to the app's log folder. It runs on the packaged Electron binary with
  `ELECTRON_RUN_AS_NODE=1`, so Node and natives match the desktop build and nothing new ships.
- **Backend**: unchanged, except `PI_KIT_PARENT_PID` names the service host and it closes open connections when it
  stops.
- **Desktop app**: a client of the service host. With a background level on (§3) it ensures the registered service runs
  and attaches; with it off it starts the service host as its own child (app-owned mode, today's lifetime). One code
  path, three owners.

### §2 Ownership and discovery

- One host per data folder: a host that finds another one answering on the folder's socket exits ("already running":
  code 3 for a host the desktop started, which then attaches to the owner; 0 for one a service manager started, so the
  manager does not keep starting it). A socket nobody answers on is left from a dead host and is replaced. Two hosts
  starting at the same instant on a stale socket could still both listen; only a service manager starts hosts for a
  registered folder, so that does not happen in practice. A held SQLite lock (the bg-agents technique) would close it.
- `<dataDir>/service.json` (0600; user-only ACL on Windows): `pid`, `version`, `level` (`app` or `login`), `socket`,
  `token`, `startedAt`, written by the host once it listens and removed when it exits (only while it still names that
  host). The host makes its own token at every start. ADR-0007's threat is other users and web pages; the same user can
  already read `auth.json`. This amends ADR-0007.
- The desktop waits for a live host in that file, enters it with its token and hands the backend's URL and token to the
  renderer as today. A service host of another version is restarted onto this one before the desktop attaches.
- Any connection with the token may ask (`status`) and command (`stop`, `start`, phone access); it becomes the desktop,
  which the backend's requests go to and whose storage seals the instance key, only by calling `attach`. So
  `pi-kit service status` never takes the place of an open window. `status` never returns the backend's token.

### §3 Two background levels

Settings › General › Background, off by default: **Keep running when pi-kit is closed** (level 1); level 2 joins it as
a choice when it exists. The row says that agents and phone access keep running and spending. Switching stops the host
that owns the folder, registers or unregisters, and restarts the app, which starts on the new owner through the normal
startup path. Switching levels unregisters the old one first.

The `pi-kit` command mirrors the switch for a terminal, also over SSH: `pi-kit service status | install | uninstall |
start | stop | restart | logs` (`--level boot` joins `install` with level 2). It is `Resources/backend/pi-kit.cjs`
(`apps/cli`, its commands in `service-cli.ts`), run by a launcher on the app's binary as Node; the switch's row offers
"Install the pi-kit command", which writes the launcher to `~/.local/bin` (`%LOCALAPPDATA%\pi-kit\bin`), the folder
`pi-kit-secret` uses. Desktop and command build the registration with the same `serviceSpec` from the same inputs, so
neither rewrites (and restarts) the other's. `status` exits with 3 when nothing runs; `stop` refuses a backend the app
owns. In both levels the watchdog inside
the host restarts the backend; the OS only starts the host and restarts it if the host itself dies. A host the OS
starts starts its backend itself; a first start that fails (a broken database) waits for a desktop to answer it.

**Level 1, "Keep running"**: per user, starts at sign-in, no admin, full access to the user's keychain and desktop.

- **macOS**: a LaunchAgent `~/Library/LaunchAgents/dev.pi-kit.app.service.plist` (`RunAtLoad`, `KeepAlive` on
  unsuccessful exit, the host's environment with `ELECTRON_RUN_AS_NODE`), loaded with `launchctl bootstrap gui/<uid>`.
  macOS lists it under System Settings › Login Items › Allow in the Background, where the user can switch it off. Not
  SMAppService yet: its plist must live in the signed bundle and cannot carry this profile's paths, while a user agent
  works for unsigned and development builds and can be tested as it ships.
- **Linux**: systemd user unit `~/.config/systemd/user/dev.pi-kit.app.service.service` with `Restart=on-failure`.
  An AppImage's files live in a mount that moves at every start, so its unit runs the image itself with `-e` and a
  loader that finds the host beside the binary, and the host derives its paths from where it sits. Without systemd the
  switch says so; an XDG autostart entry is not built.
- **Windows**: a sign-in entry in the user's `Run` key (written with `reg.exe`, no admin) that starts the app with
  `--pi-kit-service`: a windowless supervisor that runs the host and starts it again after a crash, up to five times in
  a row. Task Scheduler cannot set the environment that runs the binary as Node, and a scheduled `cmd` shows a window.
- An app whose path goes away cannot register, and the switch says why: the portable Windows build (it runs from a
  temporary folder) and a macOS app run from a disk image or translocated by Gatekeeper.
- The desktop rewrites the registration at every start when paths, version or PATH changed, which restarts the service
  onto them. Development and smoke profiles register under a name with a hash of their data folder, never the
  installed app's.
- With the service, **Quit** closes the app and leaves the backend running; the tray adds **Quit and stop the
  background service**, which stops it until the next sign-in (a clean exit is not restarted by any of the three).

**Level 2, "Start when the computer boots"**: system level, runs with nobody signed in, an administrator approves it
once. The service host still runs as the owner, never as root or SYSTEM, because the agent runs shell commands as
whoever the host is.

- **macOS 13+**: `Contents/Library/LaunchDaemons/dev.pi-kit.app.daemon.plist`, registered with
  `type: 'daemonService'`; the user approves it in System Settings › Login Items with an administrator's password. A
  bundled plist is static and cannot name the user, so the daemon is a small root launcher: it starts one service host
  per enrolled user with that user's uid, gid, `HOME` and login-shell `PATH`, and does nothing else as root. A user
  enrolls with `<dataDir>/boot.json` (0600), trusted by its owner uid, never by its content.
- **Linux**: the level 1 user unit plus `loginctl enable-linger <user>`, run by the app after the user confirms
  (polkit allows it for the active user on most distributions and asks for a password where it does not). Where linger
  is refused, a system unit in `/etc/systemd/system/pi-kit@.service` with `User=%i`, installed through `pkexec`.
- **Windows**: a Windows Service installed through UAC, under a pinned service wrapper (WinSW) signed and shipped with
  the app, since the Service Control Manager needs a process that answers its control requests. It logs on as the owner
  (the installer grants "Log on as a service" and SCM stores the password), so the profile, PATH, DPAPI and Credential
  Manager are the user's. Failure actions restart it after 10 s, 30 s and 60 s. LocalSystem is not offered.

### §4 Secrets in each level

- **App-owned and level 1**: as ADR-0019, with one opt-in on macOS where keys use Touch ID storage (a fresh macOS
  profile does not, and runs unattended as it is): Settings › General › Background offers **Read keys while I'm away**.
  On, the store copies every key it holds (the database key and the provider and connector secrets; one Touch ID read
  each) into separate Keychain items `unattended/<account>` with no access control, readable only by this signed app's
  access group, because an item's access control is fixed when it is made. The Touch ID items stay. The choice is
  `unattendedKeys` in `security.json`; the backend then selects the `macos-unattended` store at start, and the
  `pi-kit-secret` launcher pi runs carries the same setting. While on, a new key is written to both items and a deleted
  key loses its copy first; a cancelled Touch ID while copying removes the copies already made. Off removes every copy
  without a prompt, and so does switching credential storage off. Not built: handing a Touch ID-read database key from
  the desktop to the host instead (an environment variable would reach every agent's commands). Linux Secret Service and
  Windows Credential Manager read without prompts. The instance key still needs a desktop after a host restart (§5).
- **Level 2**: the user's keychain is out of reach before sign-in (Windows excepted, see below), so the host uses a
  **sealed file store**: one encrypted file in the data folder (the database's cipher), keyed by a machine-bound key:
  - macOS: a System keychain item only root can read; the root launcher reads it and hands it to the host over an
    inherited pipe.
  - Linux: a systemd credential (`systemd-creds`, TPM2 where present) for the unit, else a 0600 key file outside the
    data folder; Settings names which one protects the keys.
  - Windows: not needed; the service runs in the owner's logon, so the keyring store works as in level 1.
- Moving to level 2 copies the database key and the chosen provider keys into the sealed store on the user's click;
  moving back leaves them there until "Remove boot-time keys".
- `pi-kit-secret get` asks the service host over its socket; the key itself never enters an environment variable,
  since agents' shell commands inherit the environment.
- Never: a silent fallback to plaintext (ADR-0019 still holds).

### §5 What still needs a window

- The desktop talks to the host over a local socket (`hostSocketPath`): a Unix socket in the data folder (0600; in
  `$XDG_RUNTIME_DIR` or the user's temporary folder when that path is too long for a socket address), a named pipe on
  Windows. Any local account may open that pipe: a host the scheduled task starts runs in the task's logon session, whose
  default pipe permissions leave out the owner's unelevated sign-in. Frames are newline-delimited JSON with calls both
  ways and events; nothing is accepted before a hello that carries the host token, made fresh at every start and never
  put in an environment variable, so the token, readable only by its owner, is what keeps other accounts out. The backend keeps
  its child IPC to the host, so the `DesktopBridge` is unchanged: the host forwards its requests to the attached desktop
  or, with none attached, answers them itself (empty browser state, "needs the desktop app", no app update), so no
  request waits for a window. A desktop that signs in later attaches to a level 2 host the same way.
- Instance-key signing and the phone gateway with its foreground `tailscale serve` run in the host; the gateway serves the
  renderer from `app.asar`, which Electron's Node mode reads. The key file stays sealed by the desktop's `safeStorage`:
  the host asks the attached desktop to seal or unseal it and keeps the unsealed key in memory, so signing outlives the
  window but not a host restart without a desktop.
- App update stays in the desktop: electron-updater downloads and installs; a background host keeps running from the old
  files, and the restarted desktop restarts it onto the new version (§2). Durable agents resume (ADR-0033). There is no
  headless self-update. Windows' installer cannot replace a `pi-kit.exe` that runs, and the host and backend are
  `pi-kit.exe` too: before "Restart to update", and on a quit that installs a downloaded update, the desktop stops the
  host and waits until it has exited (after a quit-time install the service starts again at the next sign-in or app
  start). Silently, the installer itself waits up to 15 s for `pi-kit.exe` to exit and then ends what is left, which
  has no window to close; interactively, its "close pi-kit" does the same. A real uninstall (not the old version's during
  an update) removes the `Run` value and the `pi-kit.cmd` launcher.
- Tray, desktop notifications and microphone access need the desktop. Computer use needs the user's GUI session: level
  1 has it, level 2 does not (macOS daemons and Windows services run outside it), so it is refused there.

### §6 Power

- While a thread runs or a background agent is active, the host holds an idle-sleep assertion:
  `caffeinate -i -w <host pid>` on macOS, `systemd-inhibit --what=idle` around `tail --pid=<host pid>` on Linux, a hidden
  PowerShell that calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and waits for the host on Windows;
  each lets go by itself when the host dies. The host learns what is active from the backend's own status stream
  (`GET /api/threads/events`): a thread whose `activity` is `running`, or a background agent whose status is `active`. A
  thread waiting for an answer is not work. Where the command is missing the host logs it once and goes on. A closed lid
  or a user's sleep still sleeps.
- Level 2 states the limits of a reboot: with FileVault on, a Mac waits at the unlock screen after a restart or power
  loss until someone types a password (`fdesetup authrestart` covers a planned restart only); BitLocker with a PIN does
  the same on Windows.

### §7 Order of work

1. Extract the service host and run it as the desktop's child: same behaviour, the watchdog and log specs move with it.
2. `DesktopBridge` over the socket; instance key, remote gateway and `tailscale serve` move into the host.
3. Level 1 on the three systems, the setting, the CLI and a quit menu that says whether the service stops.
4. Level 1 secrets on macOS and the sleep assertion.
5. Level 2: the sealed store, then Linux linger (smallest), macOS root launcher, Windows service and wrapper.
6. A separate ADR: a headless server distribution (Node 24 tarball or container) for machines without the desktop app,
   paired through the CLI.

## Consequences

- Agents, remote access and later schedules and channels keep working with the window closed, and at level 2 after a
  reboot, and so does spending; the attendant's cap covers only the attendant, so a global daily cap is the next guard to
  add.
- Closing the window no longer means stopping; the quit menu has to say which one happens.
- The token is on disk (0600) for the life of the service instead of in memory only.
- Window and service can differ in version and must handshake.
- The backend closes open connections when it stops (`forceCloseConnections`): a window or phone still streaming events
  no longer holds a stop for the 15 s grace period. Shutdown hooks run before the server closes, so they are unaffected.
- Browser artifacts, open in editor and app update work only with the desktop attached; computer use not at level 2.
- Level 1 on macOS may keep the database key without user presence, at the user's explicit choice.
- Level 2 adds code that runs as root (the macOS launcher), a third-party binary (WinSW), a stored Windows password and
  keys that a machine, not a person, unlocks. Each is opt-in and named in Settings; uninstall removes the registration,
  the launcher's enrollment and the sealed store's key.

## Open questions

- macOS TCC: are Screen Recording and Accessibility grants attributed to the app for a host launchd starts from the
  app's binary, so computer use works at level 1? May the root launcher read `~/Library/Application Support` without Full
  Disk Access?
- Windows: users who sign in with a Microsoft account and a PIN may not know the password the level 2 service needs.
- Windows and Linux level 1 are built but not yet run on those systems: the supervisor and Run key on Windows; the user
  unit, and whether an AppImage's AppRun passes `ELECTRON_RUN_AS_NODE` and `-e` through, on Linux.
