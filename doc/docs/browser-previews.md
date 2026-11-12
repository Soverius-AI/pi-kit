# Browser artifacts and app previews

Artifacts uses the native browser inside Electron and an iframe in other browsers, including desktop Chrome and the mobile PWA. These are different sessions:

- **Electron:** the existing isolated page is the page `pi_browser` operates. Native inspection, console and viewport/selection/full-page screenshots remain available.
- **Browser/PWA:** the iframe is an ordinary app session on this device. It does not share cookies, navigation, form values or DOM state with the agent's native browser. Its toolbar offers URL entry, reload, open externally, unload and screenshot upload. Native console/inspection controls are not shown.

## Approve preview origins

The initial implementation does not proxy development servers. Supply an already reachable preview URL using an HTTPS deployment, a secure tunnel, or your own separately configured reverse proxy.

Set this trusted **service-host startup configuration** before launching/restarting the host:

```sh
PI_KIT_PREVIEW_ORIGINS=https://preview.example.com,https://another-preview.example.com
```

Entries must be exact HTTP(S) origins: no wildcards, credentials, query strings, fragments or URL paths. The default is empty, so framing is denied. Invalid configuration fails closed. Changing the configuration requires restarting the host and reloading the shell.

The gateway puts the same permitted list in the shell's CSP and its `pi-kit-preview-origins` bootstrap metadata. Agent publication cannot grant new origin permissions. The shell and private backend origins are excluded. Paired-phone previews also exclude the gateway's entire cookie hostname, even on another port: **cookies are hostname-scoped, not port-scoped**. Use a separate preview hostname without pi-kit cookies.

Local browser development can explicitly approve another local origin:

```sh
PI_KIT_PREVIEW_ORIGINS=http://127.0.0.1:5173 pnpm dev:web
```

This does not make a development server reachable from another device. `localhost` on a phone is the phone, and an HTTPS shell cannot embed an HTTP preview. The app must also permit embedding through its own CSP/`X-Frame-Options`. Pi-kit does not strip those headers, forward its credentials, or rewrite HTML. If embedding or sign-in does not work, use **Open externally**. Some login flows do not work inside an iframe because of browser cookie restrictions.

## Publish a link

The desktop-independent `pi_preview` tool publishes metadata only:

```json
{
  "op": "set",
  "sourceUrl": "http://localhost:5173",
  "previewUrl": "https://preview.example.com",
  "title": "My app"
}
```

`previewUrl` and `title` are optional. Use `{ "op": "clear" }` to clear the published link. Publication does not fetch the URL, start a server, verify loading, or change security configuration. URLs must not contain embedded credentials; do not publish secret-bearing URLs.

Successful native-browser results can also announce a changed source URL. They do not override a published `previewUrl` while the native browser stays on the same origin as its `sourceUrl`; navigating to another origin replaces the link. A user can enter a different address locally. New publications never silently replace an already loaded iframe or an edited address; **Load new URL** is explicit.

One latest preview per environment/thread is restored through hydration and retained during log compaction, including clears. Browser control remains unavailable without an attached desktop; publication must not be mistaken for native browser automation.

## Opening and dismissal

Agent browser calls no longer force Artifacts open on their own. Narrow headers offer a **Preview** shortcut when a preview or browser activity is available (icon-only on phones); Artifacts is also in the panel menu.

The first time the agent publishes a preview in the open chat, pi-kit asks whether previews should open automatically: **Always open** opens it now and from then on, **Never** stops asking, **Not now** asks again with a later publication. Change the answer with **Open previews automatically** at the bottom of the Artifacts panel. The answer is stored per device, so a phone and a desktop can decide differently; with **Always open** a phone shows the preview over the chat.

Only the first live publication per chat opens the panel or asks, and only while no other panel is open. Live means the publication arrived on the stream within 20 seconds of being stamped by the backend: connecting to a chat transfers its stored preview in the hydration snapshot, which never opens anything, and a stale stamp counts as replay.

Closing/back-to-chat, Escape, overlay dismissal or choosing another panel is respected. Repeated browser calls, publication, replay and reconnect do not undo dismissal. Dismissal is remembered locally per environment/thread, not synchronized across devices.

An iframe is not mounted until the user opens its panel. It survives temporary dismissal for the selected chat so application state is preserved; **Unload preview**, thread changes and environment changes release it. Hidden arbitrary applications may continue doing their own work. Reload/unload discard app state.

## Screenshots and debugging: current scope

Use **Upload screenshot** to add a manually captured image to an unsent composer draft. The existing attachment pipeline checks that the same thread/frame is still current. Nothing is sent automatically.

Direct permission-based screen/tab capture, desktop Chromium Region Capture, and an optional app-side console/inspection bridge are follow-up milestones. There is no iframe full-page screenshot or cross-origin DOM/console access in this initial slice. The existing JetBrains WebSandbox generated-widget integration is unchanged; full application previews use an approved dedicated origin, not an opaque widget sandbox.

An iframe load event does not prove that the app rendered successfully. Plain cross-origin previews cannot reliably report all framing, authentication or network failures, nor their current internal URL.
