# ADR-0003: pi session files are the source of truth; SQLite holds UI metadata

Status: Accepted
Date: 2026-10-15

## Context

pi persists every session as a JSONL tree under `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`
(entries with `id`/`parentId`; types such as `message`, `model_change`, `compaction`,
`branch_summary`, `custom`, `label`, `session_info`). `SessionManager` lists, opens, forks,
branches and navigates them, and the `pi` CLI reads the same files. Duplicating that content into
an app schema would create two sources of truth and break CLI interop.

## Decision

- pi's session files are canonical for conversation content, branches, compaction, labels and
  model changes. SQLite also caches conversation events for replay.
- SQLite (`better-sqlite3-multiple-ciphers`, `pi-kit.sqlite` under the backend data folder, configured by `PI_KIT_DATA_DIR`; desktop launches use Electron `userData`, while server installs supply their own data folder) holds:
  - `threads`: id (== pi session id), session_path, cwd, title, pinned, archived,
    last_opened_at, updated_at.
  - `thread_events`: AG-UI replay log.
  - `runs`: active-run lock rows.
  - `settings`: UI preferences (theme, layout, last workspace).
  - `workspaces`: known cwds.
- Thread listing is served from `threads`; a background job reconciles it with
  `SessionManager.listAll()` so sessions created by the CLI appear in the app.
- The app does not lock session files. Reconciliation detects external changes by mtime, and
  connecting to an idle thread rebuilds stale replay history from the session file.
- Deleting a thread in the app deletes its JSONL, via trash when available, as pi does.

## Consequences

- Export uses pi's HTML exporter. `/share` and `/bug` are disabled commands.
- Schema migrations cover only the metadata tables; pi migrates its own format on load.
- While the app holds a thread open, concurrent CLI writes are detected, not prevented.
