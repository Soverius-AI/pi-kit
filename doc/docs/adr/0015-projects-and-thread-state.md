# ADR-0015: Projects as sidebar groups and pushed thread state

Status: Accepted
Date: 2026-10-16

## Context

The sidebar showed one workspace at a time behind a switcher. A row knew only "running", "waiting" and "aborted / failed", read from a list the renderer polled every five seconds.
Nothing said that a thread was nearly out of context, that a run had finished while the user was elsewhere, or that the pi command line had continued a session.
With two projects open the user had to switch to find out which one needed attention.
The optional attendant agent that tends the thread list needs the same channel to deliver its summaries and suggestions.

## Decision

- **Every known folder is a project group.** `workspaces` gains `sort_order` (1..n in sidebar order; a new project goes last, reopening moves its time but not its place), `collapsed`, `hidden` and `attendant_off`.
- `GET /api/workspaces` returns projects in sidebar order with `collapsed`, `hidden`, `attendant`, `threadCount` and `branch`; `PATCH /api/workspaces` takes `{ cwd, collapsed?, hidden?, attendant? }`; `PUT /api/workspaces/order` takes `{ order: [cwd] }`. An unknown folder is 404; a partial order keeps the rest after it.
- **Branch** is read from the repository's `HEAD` file (`apps/backend/src/threads/branch.ts`), including linked worktrees and detached heads; no process is spawned, so it runs on every list.
- **Sidebar.** "Projects" with "Add project…" and a primary `+`. The current project is where the selected thread lives (`ThreadsStore.workspace` follows `select()`). A group header shows chevron, folder name, branch and running / waiting counts, with "New thread" and a project menu (New thread, Collapse / Expand, Move up / down, the attendant opt-out, Hide project) on hover. Groups reorder by drag and by menu. Hidden projects, "Show archived threads" and "Attendant activity…" live in the filter menu; Settings › Projects and trust mirrors hide / show and ordering. The switcher is gone.
- **Rows**: title, one meta line, a trailing cluster (context ring, one state glyph, short relative time) and a hover menu. Sections ("Pinned", "Today") appear only in a group with more than eight threads. Compact density drops the meta line but keeps a waiting pill. Search matches title, first message and attendant summary across projects without changing the fold.
- **Keys and commands.** ⌘1–⌘9 open the nth project (fixed, counted in clash checks); ⌘[ / ⌘] open the previous / next thread of the current project (editable `prev-thread`, `next-thread`). `/project` opens the project menu; `/attendant` toggles the attendant for it (`on`, `off`, `activity`). Both are pi-kit built-ins like `/cost`.
- **`ThreadState`** (`libs/protocol`): `activity` (`idle`, `running`, `waiting`), `question` (the pending dialog's title, eight words or 60 characters), `context` (percent or null), `lastRun`, `unread`, `unseen`, `cli`, and the attendant's `summary` and open `suggestions`. `ThreadSummary` carries it as `state` beside the older fields. `computeThreadState` (`apps/backend/src/threads/thread-state.ts`) is a pure function of the lock row, pending dialogs, stored context, the user's last look and file mtimes.
- **State is pushed, not polled.** `GET /api/threads/events` is newline-delimited JSON like the workspace watch stream: a `snapshot` of every thread first, then `state` only when a thread's JSON differs from the last push, `gone`, `list` (re-read the list) and a `ping` every 20 s. `ThreadStatusService` feeds it from the run lock (`EventLogRepository.onRunChange`, deferred one tick), the pending extension dialogs (`UiBridge.onChange`) and attendant or reconcile writes; no timer. `ThreadsStore` reconnects with a growing pause and reads the list every 60 s only as a safety net.
- **Context** is stored as `threads.context_pct` and `context_at`. An open session uses pi's `getContextUsage()` when a run ends; every other thread is measured from its file during the reconcile pass (`refreshForkCountsAndContexts`): the last response on the leaf's branch over the model's window from `PiSessionService.modelWindow`. A compaction below the last response, or no response, is unknown.
- **Unread, unseen, cli.** `threads.seen_at` is the user's last look. `unseen` is a run that ended after it; `unread` is `unseen` with a finished outcome; `cli` is a session the CLI created after start and nobody opened, or a file more than 1.5 s newer than the replay log and newer than the last look. The renderer posts `POST /api/threads/:id/seen` on open and whenever the open thread's state arrives with any of the three set.
- **Badges** rank waiting, error, context ≥ 90 %, running, aborted, context ≥ 70 %, unread, cli (`threads/thread-state.ts`). A row shows the ring from 70 %, one glyph and a "Waiting:" pill. A folded project shows the counts and its strongest other state; the open thread never lights its project.
- Clicking a waiting pill or count opens the thread and `ShellStore.openWaiting` scrolls its `.pk-approval` block into view and outlines it, looking for up to six seconds while replay finishes.
- No row text or label may contain "stop" (an aborted thread says "Aborted"), because the composer's Stop button is found by role and substring.

## Consequences

- Sidebar state is as fresh as the run lock and the dialogs; a finished run, an answered question or a new title in another window shows within a tick.
- A thread made only of an extension command has no first message and reads "New thread" until a prompt is sent.
- An idle thread's context share is a measurement of its file, not pi's estimate; the first pass reads each file once more, and an unknown model draws no ring.
- The list is still fetched whole across all projects; the cost is the transfer, since the reconcile pass scans every session anyway.
- `ThreadsStore` alone knows project order and fold; the sidebar component renders and forwards intent, computing only the drop position.
- Nothing in the sidebar is virtualised; a very long project list scrolls.
