# ADR-0012: Workspace panels, review mode and project trust

Status: Accepted
Date: 2026-10-15

## Context

The workspace needs Files, Changes and Terminal panels, a review mode and project trust. Tool results alone cannot supply reliable before-content: pi's `edit` result carries only a unified patch and `write` carries nothing about what it replaced. The implementation uses git snapshots around runs.
Project trust was meant to be a question to the user, but a development flag, `PI_KIT_TRUSTED_CWDS`, stood in for it. The
terminal needs a native pty that serves both Node and Electron, and anything typed there must stay out of the model.

## Decision

- **Terminal.** `node-pty` is pinned; its N-API prebuild serves Node and Electron with one binary, and `TerminalService` sets the execute bit on its `spawn-helper` (`ensureSpawnHelper`)
  before the first spawn; packaging keeps `node-pty` outside the asar. One login shell (`$SHELL -l`) per workspace, kept while the backend runs; the next open replays the last 256 KB.
  Nothing typed there reaches the model. Transport is a streamed `GET /api/workspaces/:id/terminal/stream` (NDJSON) plus `POST .../input`, `.../resize`, `POST .../terminal` and `DELETE`,
  not a WebSocket, so the bearer guard and CORS apply unchanged. The shell's environment drops `PI_KIT_*`, `ELECTRON_*`, `NX_*`, `npm_*`, `NODE_ENV`, `INIT_CWD` and the
  repository's `node_modules/.bin`. xterm is loaded with `import()` on first open and coloured from the design tokens; inside `.xterm` the app's shortcuts stand aside.
- **Files.** `GET /api/workspaces/:id/tree?dir=` lists one folder from the same ignore-aware index as `@` completion; rows drag into the composer as `@path`. `POST /api/workspaces/:id/open { path }`
  validates the path (`insideWorkspace`) and hands it to the desktop app over the backend's IPC channel (`stdio[3] = 'ipc'`, `PI_KIT_DESKTOP=1`, `DesktopBridge` sends `open-path`, the service host relays to Electron main, which calls `shell.openPath`); without the desktop app it answers `{ opened: false, reason }`.
- **Changes.** `GET /api/threads/:id/changes?source=thread|worktree|outcome` and `.../changes/:file`. "This thread" uses `RunSnapshotsService` snapshots before and after runs and background-agent work, comparing each changed file with its earliest before-snapshot. "Working tree" uses git status and `git diff HEAD`; "Outcome" shows the thread's attributed commits. Diffs require a git worktree. `hunksToModel` in `libs/shared/protocol/src/diff-model.ts` builds diff rows. `POST /threads/:id/revert { file, source, confirm: true }` requires confirmation and refuses during a run. `POST .../stage { source, files? }` stages the named thread files or the whole working tree with `git add -A`; it does not require confirmation.
- **Review.** Comments live in `ChangesStore` and are mirrored by `PUT /threads/:id/review-comments` into SQLite `review_comments`, pending until sent. Send builds one message
  (`buildReviewMessage`, `libs/review/util`) and carries `forwardedProps.review = { comments }`; `PiAgent` validates it (`reviewBatchOf`), appends the custom entry `pi-kit.review` before prompting
  (pi never sends it to the model), emits a `pi.review` activity (`review:<entryId>`) and drops the pending rows; `sessionToMessages` and `buildTranscript` attach it to the user block.
  `PkDiffViewer` (`pk-diff`, unified or split, `compact` for the transcript's `edit` / `write` rows) is the viewer; review mode swaps the transcript for `pk-review-view` and the composer for `pk-review-tray`.
- **Project trust.** pi's order is kept: a `project_trust` extension handler, then `trust.json`, then `defaultProjectTrust`; `TrustService` runs it when a session opens and for the dialog.
  `ask` is the dialog: the renderer calls `GET /api/workspaces/:id/trust` before selecting a thread or workspace, lists the resources found, and offers Skip this time, Trust once and
  Trust and remember (`ProjectTrustStore.set`, pi's `trust.json`); `/trust` adds Never trust. A new answer closes the folder's idle sessions (`PiSessionService.applyTrust`).
  `PI_KIT_TRUSTED_CWDS` is a test-only flag: ignored under `NODE_ENV=production`, warned about, never written to `trust.json`. Trust decides what loads, not what tool calls may do.
- **Code layout.** `apps/backend/src/pi/load-pi.ts` is the one place that loads pi's packages; Nest modules `changes`, `terminal` and `desktop`; renderer panels and review features live in their domain libraries under `libs/files`, `libs/review`, `libs/terminal` and `libs/settings`.

## Consequences

- "This thread" includes changes made through shell commands as well as edit/write tools. Snapshot attribution observes folder changes during a run, not which process wrote each file.
- Pending review comments live in SQLite; before-content lives in private git snapshot objects. Missing or pruned snapshot objects can make a diff or revert unavailable.
- The terminal keeps workspace shells alive while the backend runs.
- A review batch persisted in SQLite shows in every window of the thread; there is no merge.
- Reverting under a running pi is refused; thread diffs retain the earliest recorded before-snapshot for each file.
- The trust dialog says what will load, not that it is safe; it is not an authentication boundary.
