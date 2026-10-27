# ADR-0022: Latest dependency versions, pinned exactly, upgraded as a wave

Status: Accepted
Date: 2026-10-16

## Context

The first spike held CopilotKit back because the newer Angular package needs a newer Angular major than the workspace
had. The gap then grew across Angular, CopilotKit, AG-UI, NestJS, zod, TypeScript and the bundled pi, and some of these
pin each other (CopilotKit pins AG-UI and A2UI; AG-UI pins rxjs), so they can only move together. Holding back means
building the chat surface on an API that is already behind. The direction is the latest of everything; the bundled pi
must match the user's CLI because they share session files.

## Decision

- Every dependency is the latest published version the toolchain accepts, pinned exactly (no `^`).
- Upgrades happen as a dedicated wave, not piecemeal. A wave records in this ADR what changed in the APIs pi-kit uses.
- Any package held back is an exception, named in this ADR with its reason; the list below is that record.
- The package manager is pnpm with a hoisted
  `node_modules`, `strictPeerDependencies: false`, `autoInstallPeers: true`, an `allowBuilds` list and a
  `minimumReleaseAge`. A version published inside that window is taken with the next wave.
- One copy of a shared class: a package that CopilotKit or AG-UI pins exactly stays on that version.
- Exact-version pnpm patches may adapt a dependency (zod 4 for A2UI and the SDK, KaTeX fonts, the grammar registry;
  [patches/README.md](https://github.com/wolfmanfx/pi-kit/blob/main/patches/README.md)); zod resolves to one pinned
  4.x everywhere; there is no zod 3 boundary.
- GitHub Actions are referenced by major version; this is the one place where "exact" is not applied.
- Named exceptions, held back on purpose:
  - `typescript` 6.0.x, not 7: Angular's compiler and build and `typescript-eslint` peer on `<6.1`; with 7 Nx cannot load the project graph.
  - `rxjs` 7.8.1: `@ag-ui/client` pins it; a second copy makes `Observable` types incompatible in `PiAgent.run()`.
  - `webpack-dev-server` 5.x: `@nx/webpack` peers on `^5.0.0`.
  - `@types/node` 24.x: the runtime is Node 24 (and Electron's Node 24); newer types describe APIs that are not there.
  - `@a2ui/web_core` 0.10.4: `@copilotkit/angular` pins exactly 0.10.4; a second copy gives two unrelated `Catalog` classes.
  - `@ag-ui/client`, `@ag-ui/core` 1.0.2: CopilotKit's runtime pins 1.0.2; one `AbstractAgent`.
  - `katex` 0.16.x: CopilotKit declares `^0.16.22`; the 0.19 line is outside that range.
  - `mermaid` 11.17.2, overridden in `doc/`: `@mermaid-js/layout-elk` is built against Mermaid 11; with 12 only the first diagram of a page renders.
  - `@nestjs/swagger` 12.0.2: the next patch was published inside `minimumReleaseAge`; taken with the next wave.
  - `pnpm` 11.x, not 12: the line whose `allowBuilds` the workspace file uses.
  - `better-sqlite3-multiple-ciphers` replaces `better-sqlite3` on the same version line; Drizzle's `better-sqlite3` import is an npm alias of it.
  - `nestjs-zod`: tried and not kept; it writes a nullable DTO property as an array and fails on schemas with an `id` under swagger 12 and zod 4.
- NestJS 12 is ESM only; the backend stays one CommonJS bundle that `require()`s its ESM dependencies on Node 24.

## Consequences

- A wave is blocking: features are written against the upgraded API from the start.
- The bundled pi moves with waves; Settings › General shows when the user's CLI is older and offers `pi update`.
- Risk concentrates in the packages that pin each other (CopilotKit, AG-UI, zod, A2UI); recorded fixtures and the AG-UI
  stream verifier catch breakage there.
- The `outdated` warning keeps the exceptions visible; each is revisited at the next wave.
- Changing a pnpm patch invalidates Nx build and test results even when the package version is unchanged.
