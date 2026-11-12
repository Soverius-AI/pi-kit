# ADR-0029: Browser artifacts shared with the agent

Status: Accepted
Date: 2026-10-18

## Context

Web-project work needs a browser the person can see and the agent can operate: start the project's server, open it, inspect
it, click, read the console, take a screenshot and show the result to a vision-capable model. An iframe cannot host pages
that prohibit framing, and a page the agent drives must never reach pi-kit's own renderer, backend or credentials. Screenshot
encoding on the GUI process would stall the desktop window.

## Decision

- Each chat has an Artifacts panel (address bar, navigation, expand, close-page, an optional console pane). Agent browser
  calls open the panel; closing the panel keeps the page, closing the page releases it.
- Electron main owns a sandboxed `WebContentsView` per chat: context isolation, no Node integration, no pi-kit preload, a
  unique in-memory session partition per page. Only HTTP(S) pages are accepted; pi-kit's renderer and backend origins are
  refused, on redirects and page-initiated navigation too. Permissions and downloads are denied; popups navigate the same
  page. At most eight pages stay open; an idle hidden page is evicted first. Pages live as long as the desktop window.
- The trusted renderer's preload exposes viewport layout and the loopback-certificate preference, never page commands. The
  native view follows the selected chat, panel geometry and zoom. Hidden pages move to positive-size, nonfocusable hidden
  hosts rather than becoming parentless; zero-area/offscreen rectangles never become native bounds. Bounds-only updates
  retain the native attachment. A viewport owner stops old cleanup from hiding a newer panel. All hosts close with the main
  window. The dock is resizable by pointer and keyboard.
- Browser actions and state go through the backend's desktop bridge, forwarded by the service host to an attached desktop: `GET /api/threads/:id/browser` and
  `POST /api/threads/:id/browser/action`. Electron owns a bounded action deadline and bounded native/CDP steps;
  `DesktopBridge` owns process listeners and propagates cancellation without a competing transport deadline. Typed
  browser errors cross IPC and an exception filter maps them to 400, 503, 504, 408 and 502, so the agent sees the original
  error. The component-scoped store calls the generated SDK directly and rejects answers from an earlier chat or navigation.
- Sessions with a desktop bridge register the built-in `pi_browser` tool with a `pi_kit_browser` system-prompt section and the
  bundled `assets/skills/pi-browser/SKILL.md`; a backend without that bridge registers neither. A service-host bridge can exist with no desktop attached; browser actions then return an unavailable error. Page content is untrusted data.
- Commands run sequentially per chat. Accessibility snapshots issue references scoped to the latest snapshot; navigation
  invalidates them. Interaction and inspection use Chromium's debugger protocol (Overlay/DOM), never injected page code.
  Evaluate runs only in the sandboxed project page. Requests have a deadline and propagate agent cancellation.
- Screenshots are JPEG or PNG image content in tool results. Before snapshots/hit testing/native capture, a 1×1 CDP JPEG
  requests a compositor frame: hidden or reparented macOS views can otherwise return stale AX data, `UnknownVizError`, or
  an indefinitely pending native capture. The tiny priming image is discarded. Actual capture takes raw `capturePage`
  pixels at native scale (viewport, selection or whole page; empty and oversized regions are refused). Resizing, encoding
  and base64 run in a short-lived hidden encoder renderer with its own preload. Browser steps use the shared 60-second
  limit, including time spent queued. An interrupted action retires its page, preventing late work from corrupting the next
  capture's metrics or blocking its queue. Navigate again to create a fresh page.
- Captures, DOM properties and console entries reach the composer through `ChatStore`'s image pipeline, only after thread
  ownership and a fresh-document check; no action sends a message. Routine polls carry counts; console reads return at most 100 entries.
- A default-off, persisted preference accepts invalid HTTPS certificates for `localhost`, `127.0.0.0/8` and `::1` in artifact
  sessions only; changing it closes every artifact page. It is set over a trusted-renderer-only IPC method, not the agent API.

## Browser/PWA preview extension (2026-11-11)

Outside Electron, Artifacts now offers a separate iframe app preview rather than trying to control or stream the native page. See [Browser previews](../browser-previews.md) for configuration and current limitations. Exact preview origins are trusted startup configuration (`PI_KIT_PREVIEW_ORIGINS`), defaulting to none; shell/backend origins and paired-device cookie hostnames are excluded. Preview HTML is never proxied through the trusted API origin. The iframe uses a dedicated origin and a fixed sandbox; it is not the agent's browser session.

A desktop-independent `pi_preview` tool publishes typed `pi.preview` metadata through the existing event log/hydration. Set and clear state survives compaction. Publication grants neither framing permission nor native browser access and does not attest loading. Agent activity no longer unconditionally opens the panel: the first live publication in a chat asks once per device whether previews should open automatically (always/never/not now), dismissal is client-local and respected, and replay never opens a preview. Native automation, isolation and screenshot behavior above remain unchanged. Browser-mode screenshot upload is available; direct browser capture and instrumented debugging are deferred.

## Consequences

- Pages that forbid framing work, at the cost of a native view that must track the panel's geometry and the window's dialogs.
- Project pages are isolated from pi-kit's origins and credentials; the agent can only act through the typed action API.
- Final screenshot encoding stays off the GUI process; a tiny compositor primer and one extra encoder renderer per capture
  are the price. The repository includes Electron regression scenarios for hidden/visible/hidden-again pixels, AX freshness, scrolled
  selection, below-fold fullpage capture and recovery after pending navigation/native capture.
- Stale references, stale captures and answers from an earlier chat are rejected rather than applied.
- The certificate preference is for development only; the UI says so and that pages need reopening.
