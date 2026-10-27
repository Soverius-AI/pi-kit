# ADR-0026: The renderer is organised by domain with typed libraries and enforced boundaries

Status: Accepted
Date: 2026-10-16

## Context

The renderer was `apps/renderer/src/app/` with one folder per topic (`chat`, `core`, `settings`, `panels`, `threads`, `tree`, `review`, `mcp`, …) beside five libraries, every `project.json` with `tags: []` and the `@nx/enforce-module-boundaries` rule allowing anything to import anything.
The code already has a SignalStore and an `*.api.ts` per domain and thin components, but nothing says which domain owns a file, nothing stops `chat` from reaching into `settings` internals, `core` grows with every change, and lazy chunks stay lazy by discipline rather than by structure.
The Angular style guide asks for folders by feature with tests colocated; the Nx library types and Steyer's strategic design add a folder per domain, a small shared kernel, and typed libraries with import rules the linter enforces.

## Decision

- A domain is a bounded context, not a screen: `threads` (projects, the thread list and its state badges, worktrees, coordination), `chat` (the conversation with pi: chat page, composer, queue, interrupts, voice, generative UI), `review` (changes, the diff viewer, comment batches, conflicts), `files` (the files panel, git decoration, leases), `session-tree` (the session graph, the Entries inspector, branching), `terminal` (the terminal panel), `settings` (the dialog shell and its sections: providers and the API-key workflow, connectors, attendant, keybindings, projects and trust, advanced), `onboarding` (the first-run flow; reuses `settings` through its public API), `update` (pi and pi-kit updates).
- The shared kernel is `libs/shared/*`: `protocol` (schemas, types, the route contract), `design-system`, `ui` (pure helpers and presentational primitives that more than one domain reads: formatters, the settings catalog, keys and shortcuts, the diff viewer, the context menu), `data-access` (the API client, the NDJSON reader, the shared store traits, toasts, dialogs, theme, view prefs, health, clock, `UiStore`), `testing` (shared fakes), `pi-adapter` and `secret-store`. It never imports a domain.
- Library types inside a domain, `libs/<domain>/<type>`: `api` (what other domains may use: `export *` of the domain's `data`, plus components every consumer shares), `feature-<name>` (container components wired to the stores; a unit of ownership, lazy only where the code was lazy before), `ui` (presentational: inputs and outputs only, no store, no HTTP), `data` (the SignalStores, the `*.api.ts` classes, mappers), `util` (pure functions). A small domain starts with the types it needs; no `api` exists where nothing outside reads the domain (`files`, `terminal`).
- Tags are `scope:<domain>`, `scope:shared`, `scope:app` (`renderer`, `desktop`) or `scope:backend` (`backend`, `secret-cli`), and `type:api|feature|ui|data|util`. Nx project names are `shared-<name>` and `<domain>-<type>[-<name>]`; `tsconfig` paths are `@pi-kit/<domain>/<lib>`, with `@pi-kit/protocol`, `design-system`, `ui`, `pi-adapter`, `secret-store` and `data-access` kept as the kernel's aliases.
- Boundaries, one `depConstraints` block in `eslint.config.mjs` with the domain names in one `domains` array: `type:feature` may depend on `type:feature`, `type:ui`, `type:data` and `type:util` of its own scope, on `scope:shared`, and on other scopes' `type:api` only; `type:ui` on `type:ui`, `type:util` and `scope:shared`; `type:data` on `type:data`, `type:util`, `scope:shared` and other scopes' `type:api`; `type:util` on `type:util` and `scope:shared`; `type:api` on its own scope's `type:data` and `type:util`; `scope:shared` on `scope:shared` only; `scope:backend` crosses over only to `scope:shared`; `scope:app` may depend on anything. Both the scope rule and the type rule apply to every import, and the rule also reports a cycle in the project graph.
- Where two domains read each other for real, one side imports the other's `api` and the other declares a port: an abstract class used as an injection token, provided in `app.config.ts` with `useExisting`. The ports are `ThreadShell` and `WorktreeReview` in `threads/data` and `ChatConnectors` and `ChatTree` in `chat/data`; the chat is what everything else reads, so its ports are the smaller surface.
- Barrels are `export *` only (a named `export { X } from` keeps X's module in the initial bundle even when only a lazy chunk imports it), a lazy entry the host `@defer`s is not exported, and every library has `"sideEffects": false`. `apps/renderer/src/styles.css` lists every domain folder with `@source` so Tailwind sees the moved templates.
- New libraries come from the generator `tools/generators/domain-lib` (`nx g ./tools/generators/domain-lib:lib --domain <d> --type <t> [--name <n>]`); the rules are in `docs/structure.md`.
- `apps/renderer/src/app` holds `app.config.ts`, the shell (`app.ts/html`, `shell.store.ts`) and the toast host, nothing else; there is no route table (one page, panels switched by `UiStore`). The backend keeps its folder-per-domain layout under `apps/backend/src/<domain>`.

## Consequences

- Lazy chunks are structural: a lazy dialog is its own feature library, and the boundary rule, not discipline, keeps `chat` out of `settings` internals.
- Component selectors, test ids and the e2e suite are unchanged by the move; only imports and the ports' providers change in specs.
- New code lands in a domain library from the start; a file goes to `shared/*` only when two domains need it, otherwise it stays in the domain that uses it.
- `settings/api` hosts components (`GetModel`, `KeyWorkflow`, `LoginFlow`, `PkSetting`) because an `api` may depend only on its own `data`; there is no `settings/ui`, since `PkSetting` reads the store.
- A domain that gains a second consumer must grow an `api`; a pair of domains that start reading each other needs a port, not a cycle.
- The inventory of stores is unchanged; this decision adds where each store lives.
