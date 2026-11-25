# @pi-kit/computer-use

Opt-in computer use for [pi](https://github.com/earendil-works/pi) 1.3 or newer: the agent can look at your screen and operate native apps and browsers on **macOS, Windows and Linux**, through [Cua Driver](https://github.com/trycua/cua). A normal pi package, so it works in the pi command line and in pi-kit alike.

Cua Driver runs **inside the pi process** through its npm SDK ([`@trycua/cua-driver`](https://www.npmjs.com/package/@trycua/cua-driver), MIT). The native library for your OS comes with `npm install`: no installer, no daemon, no PATH entry.

```
pi install npm:@pi-kit/computer-use      # or: pi install ./packages/pi-computer-use
```

pi-kit ships this package and installs it into pi once (like `@pi-kit/learn`); its macOS (Apple silicon), Windows (x64, arm64) and Linux (x64, arm64, glibc) builds carry the matching Cua Driver binaries, provisioned at packaging time by `scripts/natives.mjs` from the versions pinned in `pnpm-lock.yaml`. No binary is kept in git.

Installing does nothing yet. Computer use is **off until you turn it on**:

| Command | |
|---|---|
| `/computer-use on` | asks once, then gives pi the tools |
| `/computer-use off` | takes them away |
| `/computer-use setup` | macOS: opens the permission pages one at a time (Windows and Linux need none; Hyprland is told it is read-only) |
| `/computer-use status` | on or off, whether permissions are ready, and on Linux the session type (Hyprland: read-only) and the driver's own check while it runs |

## Linux

Nothing to grant, but more to have in place than on the other platforms. The driver talks to the desktop session directly, so it needs a graphical session; a build run without a display has no desktop to look at. The AppImage carries the driver's library, which links the X11 client libraries (`libXi`, `libxkbcommon`, `libxcb`): a minimal install may need `libxi` installed.

- **X11** is the best supported: capture, input and the accessibility tree.
- **Wayland** is compositor by compositor. In a Wayland session this package turns on the driver's native Wayland routes (`CUA_DRIVER_RS_ENABLE_WAYLAND=1`, unless you set it yourself; `0` turns them off). Without them only apps running under XWayland are reached, and with neither XWayland nor the native routes there is nothing to drive.
- **The accessibility tree** (reading a window, acting on an element) needs the AT-SPI bus: install `at-spi2-core`. Desktops without a full GNOME or KDE session may not start it; Qt apps also need `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`.
- **Hyprland (Omarchy):** pi-kit supports window discovery, screenshots where the compositor can identify the window, and actions on accessible elements via AT-SPI. Raw input is experimental. Cua's Hyprland input route uses an enabled `cua-hyprland-plugin` built for the running Hyprland ABI; pi-kit does not ship or enable the plugin. `hyprctl -j cua:status` should report an ABI match and a ready input transport, not just discovery. Native Wayland apps must bind the agent seat for background input; Chromium, Electron and XWayland are not supported by that route. See Cua's [platform support](https://cua.ai/docs/reference/cua-driver/platform-support) and [Omarchy VM guide](https://cua.ai/docs/cua-sdk/guides/omarchy). pi-kit Settings and `/computer-use` still show the read-only warning, even when an experimental input route is available.

## macOS permissions

macOS gives **Accessibility** and **Screen & System Audio Recording** to the app that started pi (your terminal, or pi-kit), not to this package. `/computer-use setup` goes through them one page at a time: it asks macOS (which adds the app to each list, switched off), opens the page and says which app to switch on. Each step moves on by itself as soon as macOS reports the grant; "Done, next" is there for when it does not. macOS applies a new Screen Recording grant only to an app that starts again, so setup ends by saying so. Until both are granted, every computer tool says what is missing.

**In pi-kit**, Settings › Computer use does the same with live state: the on/off switch (the same saved choice as `/computer-use on | off`), both permissions with an Open System Settings button each, which app macOS asks (pi-kit; **Electron** for a development build, whose permissions are separate; the terminal when the backend was started from one) and, after a Screen Recording grant, a Relaunch button. An ad-hoc signed build is flagged: macOS forgets its permissions whenever it is rebuilt. While a permission is missing, threads show a "Set up computer use permissions" pill that opens that page (`/settings computer-use`).

## What pi gets

Cua Driver's own tools, read from the driver when computer use turns on and named `computer_<tool>` (`computer_list_windows`, `computer_get_window_state`, `computer_click`, `computer_type_text`, ...). The 20 common ones are in the tool list; the rest are found with `tool_search`. Screenshots come back as images.

## Approval

- Looking (list apps, read a window, screenshot) runs.
- Acting (click, type, press keys) asks **once per session**.
- Running a script, quitting an app, downloading or storing something asks **every time**.
- A run with no way to ask (print or JSON mode) cannot act.

What counts as looking comes from each tool's own `readOnlyHint` and `risk` from Cua Driver, so new tools need no change here. In pi-kit the questions appear as its Allow / Deny blocks. Anything on screen is untrusted text: a page or document can contain instructions meant for the agent.

## Notes

- The SDK is pre-1.0 and pinned (`0.62.1`).
- Cua's installers send install telemetry; this package does not use them. Check Cua's documentation for what the SDK itself reports.
- The optional `cua-perception` add-on bundles AGPL models and is not used.
- The one saved choice (on or off) is `<agent dir>/computer-use.json`.

```
extensions/computer-use.ts   the commands, the tools, the approval question, the setup steps
lib/computer-use.mjs         the logic without pi or the driver in it (tested)
lib/host.mjs                 what a host app uses: the saved choice, the app macOS asks, the permissions (pi-kit's Settings page)
```
