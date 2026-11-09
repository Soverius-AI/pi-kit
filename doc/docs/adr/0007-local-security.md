# ADR-0007: Backend binds to loopback with a per-launch token

Status: Accepted
Date: 2026-10-15

## Context

The backend can run shell commands and edit files as the user. Without protection, any local
process or any web page in a browser could POST to it. CopilotKit's runtime has no auth of its
own for a self-hosted agent; OpenDots also sets `cors: { origin: [] }` and passes auth headers
from the client.

## Decision

- The backend listens on `127.0.0.1` only, on a random free port allocated by the service host.
- The service host allocates a 32-byte token for the backend and passes it via the environment;
  Electron exposes the endpoint to its renderer through the preload. Protected requests (REST and AG-UI SSE) must carry
  `Authorization: Bearer <token>`; a Nest guard rejects the rest. CORS allows only the renderer
  origin. Port and token are kept across watchdog restarts of the backend.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload
  exposes native operations including: `getBackendUrl()`, `getToken()`, `openExternal()`, `showOpenDialog()`,
  `setThemeSource()`, `systemTheme`, `getBackendStatus()`, `onBackendStatus()`. The service host relays desktop requests from the backend to Electron over IPC.
- MCP Apps iframes run in an own host with a token-free proxy route served by the backend
  (the pinned CopilotKit has no `sandboxProxyUrl`).
- Project trust: on first open of a cwd the UI asks before project-local extensions, skills and
  MCP servers load, mirroring pi's `/trust` flow.
- Provider authentication uses pi's auth storage; MCP OAuth uses `mcp-auth.json`. Connector
  credentials can use pi-kit's credential store, with an explicitly reported plaintext fallback.

## Consequences

- `curl` against protected backend routes needs the token. Browser development obtains it
  from the development-only `/api/dev/token` route.
- Running the renderer in a normal browser during development works with the token in
  `localStorage`, set by the dev script.
- Unauthenticated routes are explicitly marked public, including sandbox resources and the
  development-only token route; the global bearer guard protects other routes.
