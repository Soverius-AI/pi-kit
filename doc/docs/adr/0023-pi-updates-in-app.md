# ADR-0023: pi updates from inside pi-kit through pi's managed install

Status: Accepted
Date: 2026-10-16

## Context

pi-kit bundles the pi SDK under its resources; the earlier update check only said "run `pi update`". pi has a
managed install: `<agent dir>/install/managed-install.json` (`layout: releases-v1`), one fully pinned copy per version
under `install/releases/<version>/`, a `current-version` file, a launcher `<agent dir>/bin/pi` and a symlink on PATH.
`pi update` installs a new release there and moves `current-version`; pi updates itself only when it runs from inside
`releases` with `PI_MANAGED_INSTALL_ROOT` set. Writing into the app bundle is wrong: it breaks the macOS signature and
would need re-downloading on every pi-kit update. So the app uses pi's mechanism and loads pi from the newest
compatible place.

## Decision

- Resolution order for the SDK the backend loads (`apps/backend/src/pi/pi-resolution.ts`, `load-pi.ts`):
  `PI_KIT_PI_DIR`; then the release `current-version` names when it is intact, not older than the bundled copy and
  inside `piSdk: { min, max }` of the root `package.json`; else the newest release that qualifies; else the bundled copy.
  A release passed over leaves a note; the choice is made once per process and shows in `GET /api/about` and Settings.
- "Use previous release" (Settings › Advanced) writes `pi-release.json` in pi-kit's data folder; it changes the
  resolution only, never pi's `current-version` or symlink.
- Updating is one backend job (`POST /api/update { targets }`, status and NDJSON events, cancel): `pi update --all`
  when a managed install exists, else a first release is bootstrapped from the bundled copy by pi's own steps
  (`managed-install.ts`, pi's lock, marker and prune conventions), then `pi update --extensions`, `pi update --models`,
  then pi-kit's own update. pi runs as the managed current release's own CLI with `PI_MANAGED_INSTALL_ROOT`. A failed
  step does not stop the others. Output goes to a progress toast, Settings and `update.log` under `PI_KIT_LOG_DIR`.
- Checks run shortly after launch and every six hours (`PI_OFFLINE` and `PI_SKIP_VERSION_CHECK` turn them off); a
  timer re-reads the install folders, so an update made in a terminal becomes "Restart to use …" without a new check.
  "What is installed" for pi is what the `pi` command runs.
- A running backend keeps its loaded version. `POST /api/update/restart` ends the process and the desktop watchdog
  starts it again on the same port and token; threads replay from the runner log. Outside the desktop app the endpoint
  refuses unless `PI_KIT_ALLOW_RESTART=1`. A managed release above `piSdk.max` is listed with a note, not loaded, until
  a pi-kit update raises the range; the bundled copy keeps working.
- "Install the pi command" writes pi's launcher and symlink when the entry point does not lead to one; it replaces a
  dead link and never a working `pi` or a real file. On Windows the bootstrap invokes `npm.cmd` through `ComSpec` with
  fixed arguments and reports a missing npm plainly.
- pi-kit's own updates use `electron-updater` (pinned, `autoDownload` off) against the project's GitHub releases
  (`PI_KIT_UPDATE_REPO` at build time); the backend drives it over the `app-update` IPC channel so schedule and UI stay
  in one place; the mac target is dmg plus zip. `UpdateStore`, a SignalStore, owns status, output and every call;
  the Settings rows, the toast and the sidebar dot render it and forward intent.

## Consequences

- The terminal and the app run the same pi version and share session files without skew.
- The bundled pi is a fallback and a bootstrap source, not the running copy once an update happened; releases still
  bump it.
- Two files in pi-kit's data folder: `pi-release.json` (the pin) and `update-state.json` (last refresh times).
- A restart ends a run in progress as aborted, like any restart.
- The earlier update check leaves `SettingsState`; `GET /api/about/pi-update` stays and `UpdateService` calls it.
- The release repository must be set before the first release is cut.
