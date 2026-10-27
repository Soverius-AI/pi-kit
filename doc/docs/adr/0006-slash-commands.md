# ADR-0006: One command registry: pi's discovered commands plus reimplemented built-ins

Status: Accepted
Date: 2026-10-15

## Context

pi has four kinds of `/` input: `/skill:name args` and `/template args` (expanded by
`session.prompt()` before sending), extension commands (`pi.registerCommand`, executed by
`prompt()` immediately, even mid-run, may open `ctx.ui` dialogs), and built-in TUI commands
(`/model`, `/tree`, `/fork`, `/compact`, `/settings`, ...), which are interactive-mode only and
do not execute when sent through `prompt()`. The first three kinds are discoverable through the
SDK (`SlashCommandInfo { name, description, source, sourceInfo }`); the SDK also exports
`BUILTIN_SLASH_COMMANDS` (name, description, argumentHint).

## Decision

- Nest `CommandsService` merges pi's discovered commands with an own built-in table and serves
  `GET /api/threads/:id/commands`. Each entry: `name, description, source, argumentHint,
  kind: "prompt" | "action"`.
- `kind: "prompt"` (skills, templates, extension commands): the composer sends the raw text
  through AG-UI as the user message; pi expands it.
- `kind: "action"` (built-ins): the composer dispatches locally to a REST endpoint or UI panel:

  | command | implementation |
  |---|---|
  | `/model`, `/thinking`, `/scoped-models` | model picker panel → `PATCH /threads/:id/model` |
  | `/tree` | opens the tree panel |
  | `/fork`, `/clone`, `/new`, `/resume` | threads REST (`SessionManager.forkFrom`, `createBranchedSession`, `create`) |
  | `/compact [instructions]` | `POST /threads/:id/compact` |
  | `/name` | `PATCH /threads/:id` (`appendSessionInfo`) |
  | `/session` | info panel from `getSessionStats` |
  | `/reload` | `POST /threads/:id/reload` |
  | `/export`, `/copy` | `POST /threads/:id/export`, clipboard |
  | `/settings`, `/login`, `/logout`, `/trust`, `/import`, `/llama` | settings panels; trust uses pi's project-trust flow; `/llama` opens Local models |
  | `/hotkeys`, `/changelog`, `/quit` | app-level |
  | `/share`, `/bug` | listed as disabled |

- The composer's `/` menu shows all commands grouped by source with badges and fuzzy search.
- Mid-run input: the composer shows a Steer / Follow-up toggle and the request carries the choice.
- `@path` completion inserts the path text only; pi's own `read` tool does the reading.
- `!command` runs through `POST /threads/:id/bash` and renders as a `pi.bash` activity.

## Consequences

- Parity with the CLI is a table that can be audited; a missing built-in is a visible gap.
- Extension argument completion (`AutocompleteProviderFactory`) is a later addition.
