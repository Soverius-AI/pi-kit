# ADR-0004: Nx monorepo with Angular, NestJS and Electron

Status: Accepted
Date: 2026-10-15

## Context

Three runtime pieces share types (AG-UI custom event names, REST DTOs, thread models) and must
be built, linted and tested together. Nx has first-party generators for Angular and NestJS and a
community plugin for Electron, and its affected-graph builds matter as the apps grow.

## Decision

```
pi-kit/
  apps/
    desktop/      Electron main + preload (spawns backend, opens renderer, IPC for native bits)
    renderer/     Angular 20 standalone app, Tailwind + daisyUI, @copilotkit/angular
    backend/      NestJS: CopilotRuntime mount, PiAgent, PiAgentRunner, REST modules, SQLite
  libs/
    protocol/     Shared TS: custom event names + payload schemas (zod), REST DTOs, thread types
    pi-adapter/   Pure functions mapping pi session events -> AG-UI events (no Nest)
    ui/           daisyUI-based Angular components with no app state (tree view, command menu, ...)
  docs/           ADRs and design documents
```

- Package manager: npm (pi's own repo uses npm). Node 24.
- Electron main starts `backend` as a child process on `127.0.0.1:<random port>` and passes port
  and token to the renderer through the preload. In dev, `nx serve` runs all three.
- The renderer loads from the `app://` custom protocol in production and from the Angular dev
  server in development.

## Consequences

- One `package.json`, one lockfile, one TypeScript version.
- Electron packaging (electron-builder) is independent of the rest; everything else runs as plain
  Node + browser.
- `libs/pi-adapter` holds the only non-trivial mapping logic and is where most unit tests live.
