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
  native view follows the selected chat, panel geometry and zoom, detaches while application dialogs are visible, and a
  viewport owner stops an old component's cleanup from hiding a newer panel. The dock is resizable by pointer and keyboard.
- Browser actions and state go through the backend's desktop IPC channel: `GET /api/threads/:id/browser` and
  `POST /api/threads/:id/browser/action`. `DesktopBridge` owns every request deadline and its process listeners; typed
  browser errors cross IPC and an exception filter maps them to 400, 503, 504, 408 and 502, so the agent sees the original
  error. The component-scoped store calls the generated SDK directly and rejects answers from an earlier chat or navigation.
- Every desktop pi session registers the built-in `pi_browser` tool with a `pi_kit_browser` system-prompt section and the
  bundled `assets/skills/pi-browser/SKILL.md`; a web-only backend registers neither. Page content is untrusted data.
- Commands run sequentially per chat. Accessibility snapshots issue references scoped to the latest snapshot; navigation
  invalidates them. Interaction and inspection use Chromium's debugger protocol (Overlay/DOM), never injected page code.
  Evaluate runs only in the sandboxed project page. Requests have a deadline and propagate agent cancellation.
- Screenshots are PNG image content in tool results. Capture takes raw `capturePage` pixels at native scale (viewport,
  selection or whole page; empty and oversized regions are refused); resizing, encoding and base64 run in a short-lived
  hidden encoder renderer with its own preload, destroyed on success, failure, cancellation, crash or a 20-second deadline.
- Captures, DOM properties and console entries reach the composer through `ChatStore`'s image pipeline, only after thread
  ownership and a fresh-document check; no action sends a message. Routine polls carry counts; console reads return at most 100 entries.
- A default-off, persisted preference accepts invalid HTTPS certificates for `localhost`, `127.0.0.0/8` and `::1` in artifact
  sessions only; changing it closes every artifact page. It is set over a trusted-renderer-only IPC method, not the agent API.

## Consequences

- Pages that forbid framing work, at the cost of a native view that must track the panel's geometry and the window's dialogs.
- Project pages are isolated from pi-kit's origins and credentials; the agent can only act through the typed action API.
- Screenshot encoding never runs on the GUI process; one extra renderer per capture is the price.
- Stale references, stale captures and answers from an earlier chat are rejected rather than applied.
- The certificate preference is for development only; the UI says so and that pages need reopening.
