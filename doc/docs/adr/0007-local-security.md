# ADR-0007: Backend binds to loopback with a per-launch token

Status: Accepted
Date: 2026-10-15

## Context

The backend can run shell commands and edit files as the user. Without protection, any local
process or any web page in a browser could POST to it. CopilotKit's runtime has no auth of its
own for a self-hosted agent; OpenDots also sets `cors: { origin: [] }` and passes auth headers
from the client.

## Decision

- The backend listens on `127.0.0.1` only, on a random free port chosen by Electron main.
- Electron main generates a 32-byte token per launch, passes it to the backend via env and to
  the renderer via the preload. Every request (REST and AG-UI SSE) must carry
  `Authorization: Bearer <token>`; a Nest guard rejects the rest. CORS allows only the renderer
  origin. Port and token are kept across watchdog restarts of the backend.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload
  exposes a minimal API: `getBackendUrl()`, `getToken()`, `openExternal()`, `showOpenDialog()`,
  `setThemeSource()`, `systemTheme`, `getBackendStatus()`, `onBackendStatus()`. The backend
  reaches Electron main over one IPC channel.
- MCP Apps iframes run in an own host with a token-free proxy route served by the backend
  (the pinned CopilotKit has no `sandboxProxyUrl`).
- Project trust: on first open of a cwd the UI asks before project-local extensions, skills and
  MCP servers load, mirroring pi's `/trust` flow.
- Secrets (provider keys, OAuth) stay in pi's own `~/.pi/agent/auth.json`; the app never stores
  them.

## Consequences

- `curl` against the backend needs the token; a `pi-kit token` dev helper prints it.
- Running the renderer in a normal browser during development works with the token in
  `localStorage`, set by the dev script.
- The token-free proxy route is the one unauthenticated path and stays limited to the MCP Apps
  sandbox.
