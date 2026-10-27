# ADR-0016: An optional attendant agent that tends the thread list

Status: Accepted
Date: 2026-10-16

## Context

A list of twenty untitled threads, each labelled with its first message, is hard to scan, and a question that waits for an answer is often a routine "run the tests?".
pi has the pieces: an `AgentSession` can be created with any model, no tools and an in-memory session.
pi-kit has the places to show results: the thread row's meta line, the approval block, the tree's labels.
The cost of a second agent is the user's to decide, and it must never send anything on the user's behalf.

## Decision

- **Off by default.** While off nothing in it runs and no model is called. `enqueue`, every trigger, the sweep and `POST /api/attendant/run` (409 while off) check `settings.enabled` first; switching off empties the queue and aborts the request in flight. `GET /api/attendant` reports `calls` and `queued`.
- **Four tasks.** Title (2 to 12 words, at most 80 characters, written as pi's `session_info` through `ThreadsService.patch`, only for an unnamed thread answered once; a user's name is never replaced). Summary (one line, at most 100 characters, in `thread_meta.summary`). Label (1 to 5 words for a fork point, at most two per pass, never again for the same point). Draft answer for a pending `confirm` or `select`: one of the offered options or SKIP, with SKIP demanded for anything that deletes, overwrites, publishes, spends, runs unknown code or touches credentials.
- Labels and drafts are `thread_suggestions` (kind `label` or `answer`) the user accepts by clicking; the attendant never prompts a thread's session, answers a dialog or writes a label itself. Free-text and editor questions are not drafted.
- **Model access.** Every request is a fresh pi `AgentSession` from `AttendantModel` (`apps/backend/src/attendant/attendant-model.ts`, the only attendant file that touches pi, via `loadPi()`): the configured model, thinking off, `noTools: "all"`, in-memory session and settings, a resource loader that finds no extensions, skills or context files, disposed after the reply and aborted after 90 s. "Automatic" picks the cheapest model pi can use; an unusable configured model falls back to it with a log warning. `AttendantModelPort` is the test seam.
- **Triggers** (`AttendantService`): a run ended (`EventLogRepository.onRunChange`, 1.5 s later), a thread asked a question (`PiSessionService.onDialogsChanged`, which also drafts), a sweep every N minutes (0 is never) over at most ten threads whose file changed since `thread_meta.looked_for`, and one sweep on switch-on. Jobs run one at a time in a queue that holds a thread once; questions go first, then ended runs and manual requests, then the sweep. Archived, empty and opted-out threads are skipped.
- **Daily cost cap** in USD per local day (default $0.50, `null` for none), checked before each request; at the cap the attendant rests until tomorrow and records one skipped action.
- **Per project** opt-out is `workspaces.attendant_off`, set from Settings › Attendant, the project menu and `/attendant`.
- **Storage**: `thread_meta`, `attendant_actions` (every request or refusal with kind, status `done` / `skipped` / `error`, model, tokens, cost) and `thread_suggestions` (state `open` / `accepted` / `dismissed`); settings as one JSON value under the `attendant` key of `settings`, validated by `AttendantSettingsSchema`. An answer suggestion expires with its dialog. The status channel carries `summary` and open suggestions.
- **UI.** The summary is the sidebar meta line and searchable; drafts are info pills ("Allow, suggested", "Label …"). `ShellStore.acceptSuggestion` opens the thread and resolves the question through the same `interrupt.resolve` the approval buttons use. Settings › Attendant holds the switch, model, schedule, cap with today's spending, project switches and an activity table with "Look now". `/attendant activity` opens it.
- Replies from small models are cleaned (quotes, a "Title:" lead) and refused when they are not a title, a line or an offered option; a refusal is an `error` action, not a silent loss.
- **Follow-up prompts** are a separate "Suggest my next prompt" switch under Settings › Attendant › Automation, off by default and requiring the attendant. `FollowUpService` queues one prediction after a successful run or a settled background-agent change, with the same model, queue, project exclusions, cap and accounting; not for archived or verification threads, failed or stopped runs, queued input, pending dialogs or active agents.
- A prediction's context is the original request, the latest eight messages and up to twelve agents' states; it may answer `SKIP` (still charged). Suggestions and actions gain kind `prompt`. A prediction targets a fingerprint of the run, branch tail and agent states; any new run, navigation, dialog or agent change expires it, and restarts drop it.
- The empty composer shows ghost text with accept and dismiss buttons; Right Arrow accepts into an editable draft, Escape dismisses, Enter never submits ghost text. Acceptance is acknowledged on the backend and inserted only if thread, branch and draft still match. Nothing is sent and no agent is spawned until the user sends.

## Consequences

- A hosted model costs money from the first thread finished after switching on; the cap bounds a day and the activity view itemises each request.
- The attendant is one more request on the model server the threads use; a local server that holds one model swaps models when the attendant picks another, which can stall a running thread.
- Titles become ordinary `session_info` entries in the user's pi session files, as an in-app rename does.
- There is no learned user profile: drafts and predictions are the model's reading of the conversation, so a wrong one costs a click.
- The first sweep after switching on looks at ten threads, not the whole history.
