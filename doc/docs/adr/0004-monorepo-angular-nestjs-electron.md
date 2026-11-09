# ADR-0004: Nx monorepo with Angular, NestJS and Electron

Status: Accepted
Date: 2026-10-15

## Context

The three main desktop runtime pieces share types (AG-UI custom event names, REST DTOs, thread models) and must
be built, linted and tested together. Nx has first-party generators for Angular and NestJS and a
community plugin for Electron, and its affected-graph builds matter as the apps grow.

## Decision

```
pi-kit/
  apps/
    desktop/      Electron main + preload (connects to service host, renderer, native IPC)
    renderer/     Angular 22 standalone app, Tailwind + daisyUI, @copilotkit/angular
    backend/      NestJS: CopilotRuntime mount, PiAgent, PiAgentRunner, REST modules, SQLite
  libs/
    shared/
      protocol/   Shared event schemas (zod), REST DTOs and thread types
      pi-adapter/ Pure mappings from pi session events to AG-UI events (no Nest)
      ui/         Shared Angular components
      design-system/ Tokens, stylesheets and Angular primitives
    chat/, threads/, settings/, ... Feature, data, API and utility libraries
  doc/docs/       Public documentation and ADRs
```

- Package manager: pnpm with a hoisted `node_modules` tree. Node 24 or newer.
- Electron connects to or starts the shared service host, which supervises `backend` on
  `127.0.0.1:<random port>`. The preload gives the renderer the backend URL and token. In development, `pnpm run dev` orchestrates the builds and processes.
- The renderer loads from the `app://` custom protocol in production and from the Angular dev
  server in development.

## Consequences

- One `package.json`, one lockfile, one TypeScript version.
- Electron packaging (electron-builder) is independent of the rest; everything else runs as plain
  Node + browser.
- `libs/shared/pi-adapter` isolates session-to-AG-UI mappings from Nest and Angular; feature
  libraries and backend modules have their own tests.
