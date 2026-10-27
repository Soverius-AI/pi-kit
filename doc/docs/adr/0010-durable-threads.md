# ADR-0010: Durable threads: replay, SQLite layout, run locks and reconcile

Status: Accepted
Date: 2026-10-15

## Context

`PiAgentRunner` replaces `InMemoryAgentRunner` under CopilotKit's runtime, the thread list lives in SQLite next to
pi's own session files, and the sidebar works from it. The runner contract says the runner does not persist user
messages on its own, and the thread-to-session mapping previously lived in memory only. The log must survive a
reload mid-run and a killed process, the CLI may continue a session behind the app's back, and two runs must never
share a thread.

## Decision

- **User messages replay through `RUN_STARTED.input.messages`.** `RUN_STARTED` is stored and streamed with `input.messages = [the prompt]` and nothing
  else of the input; `@ag-ui/client` adds those messages on `connect()`. After a run ends the log also holds a `MESSAGES_SNAPSHOT` built from pi's session file, the canonical transcript.
- **SQLite.** `better-sqlite3` (N-API prebuilt: one binary for Node and Electron, no `electron-rebuild`). File `pi-kit.sqlite` in `PI_KIT_DATA_DIR`, WAL mode;
  Electron passes `app.getPath('userData')` after `app.setName('pi-kit')`, `dev:web` uses `<repo>/.pi-kit-data`, the fallback is `./.pi-kit-data`. Migrations are
  plain `.sql` files in `apps/backend/src/db/migrations`, applied in name order at startup, each in a transaction, recorded in `schema_migrations`; pi migrates its own files.
- **Columns added to the thread tables.** `threads`: `preview`, `origin` (`app` | `cli`), `parent_session_path`, `message_count`, `created_at`, `log_mtime`;
  `thread_events`: `run_id`; `runs`: `status`, `started_at`, `ended_at`; `workspaces`: `name`, `last_opened_at`; `settings`: `value_json`.
- **Thread id == pi session id.** Sessions are created with `SessionManager.create(cwd, undefined, { id })`; `PiSessionService.open()` corrects the path if pi picks another. A run for an unknown thread id creates that thread.
- **A run belongs to the runner, not the HTTP request.** A disconnecting client does not stop pi; `stop()` calls `session.abort()`. The lock is an in-process
  `Map<threadId, ActiveRun>` plus a `runs` row under a partial unique index (`UNIQUE (thread_id) WHERE status = 'running'`); a second `run()` throws `Thread already running`.
- **Log.** Every event is appended to `thread_events` synchronously, in emit order, before it reaches the client (WAL, `synchronous = NORMAL`). `connect()` reads
  the log and subscribes to the live feed in one synchronous step; events carry their `seq`, so a late client sees history then the rest of the run without a gap or a duplicate.
- **Snapshot and compaction.** When a run ends, a `MESSAGES_SNAPSHOT` of the active branch (`sessionToMessages()`, `libs/pi-adapter`) goes into the log only,
  before the terminal event. Before the last snapshot, the content deltas (`TEXT_MESSAGE_CONTENT`, `REASONING_MESSAGE_CONTENT`, `TOOL_CALL_ARGS`) of completed
  blocks and all earlier snapshots are deleted; events after the last snapshot are never touched, so a killed run keeps its partial text.
- **Stale runs.** At startup every `runs` row still `running` gets closing events for its open blocks and `RUN_ERROR { code: "aborted" }`, is marked `aborted`,
  and its thread's `log_mtime` moves to the file's mtime. The desktop app passes `PI_KIT_PARENT_PID`; the backend exits when that process is gone.
- **The log is a cache of pi's file.** `threads.log_mtime` is the file's mtime when the log last matched it. On `connect()` for an idle thread whose file is newer
  or that has no log, the log is replaced by `RUN_STARTED`, one `MESSAGES_SNAPSHOT` of `getBranch()` and `RUN_FINISHED` (`runId` `history-<mtime>`).
- **Thread REST.** `GET/POST /api/threads`, `GET/PATCH/DELETE /api/threads/:id`, `POST .../fork` and `.../clone`, `GET /api/workspaces`, `GET /api/settings`, `PUT /api/settings/:key`;
  shapes are zod in `libs/protocol`. `PATCH { title }` writes pi's `session_info`; `DELETE` trashes the file (`trash` CLI, else unlink) and answers 409 while running; `fork` is
  `SessionManager.forkFrom`, `clone` is `createBranchedSession(leaf)` on a throwaway manager, both with `origin: "app"` and `parent_session_path`. `pinned` and `archived` exist only in SQLite; archived threads are hidden unless `?archived=1`.
- **Reconcile.** `ThreadsService.reconcile()` runs at startup (not awaited) and every 30 s: `SessionManager.listAll()` is upserted, unseen rows get `origin: "cli"`,
  `pinned`/`archived` are never overwritten, pi's session name wins for the title, `workspaces` is topped up from the sessions' `cwd`s, a thread whose file vanished is removed. One pass at a time.
- **Renderer.** `ThreadsService` polls REST every 5 s while the window is visible and refreshes when a run ends; the shared agent store is emptied before switching threads; the selected thread and workspace are kept in `settings`.

## Consequences

- A run survives the window: a reload mid-run is safe and the run can be watched again; quitting ends it, and the next start shows it as aborted with
  everything streamed up to the kill. `pi -c` and `pi --session` keep working on the same file; the app picks up what the CLI wrote on the next open.
- What pi never persisted leaves the context after the next snapshot: partial text of a killed run shows in the replay but not in pi's file; tool calls that
  were still executing when the process died get a stand-in result ("interrupted") from `sessionToMessages()`.
- A `stop()` that arrives before pi has started the prompt has nothing to abort; the run proceeds.
- The log's size is bounded by the number of runs times the structural events, not by streamed text.
- The orphan watch and the stale-run recovery assume one backend per database file.
