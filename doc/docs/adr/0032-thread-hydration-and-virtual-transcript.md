# ADR-0032: Hydrate thread state, cache cursor replay and virtualize the transcript

Status: Accepted
Date: 2026-10-18

## Context

Opening a long thread blocks the renderer while it reapplies every stored AG-UI event, most of them small tool-argument chunks: the client reducer structure-clones state per event, and tens of thousands of chunks make single main-thread tasks last seconds, although the session file is small and the backend is idle.
Every thread switch repeats the full replay because the client keeps nothing; repairing finished logs does not help the unfinished tail of a running prompt, and a cache only helps a client that has visited the thread.
The runner appends the final message snapshot twice, once explicitly and once through `emit`; incremental compaction starts at the first duplicate snapshot and never visits the chunks before it, so affected logs never shrink.
Rendering the whole history as DOM rows costs layout and memory in proportion to the conversation, and a manual history window needs the user to expand it.
Runtime discovery replaces an explicitly configured local agent with a standard proxy under the same `pi` id, so the real connection bypasses its cache and transport.

## Decision

- **Log repair.** The runner emits the final snapshot once. Before replaying an oversized idle log, a full compaction pass repairs the existing thread; the session file, final messages, custom events and incomplete live tails are preserved.
- **Hydration.** New clients opt in with `x-pi-kit-hydrate: 1`. The backend projects the durable AG-UI history into current messages, state, reasoning timings, queue, status, composer registrations and error state, and sends it as one `pi.thread.hydrate` custom event inside the current run's lifecycle. A suspended question is restored through the standard interrupt outcome.
- Hydration reads the log without deleting or compacting it; run-completion retention is unchanged. AG-UI remains the protocol for runs, results, activities, interrupts and every live event.
- Projection, cursor capture and subscription to the active run happen synchronously; only later events follow the snapshot. Partial text and tool arguments stay in the hydrated messages so the next live delta appends exactly once. A retained cursor with no changes returns no history; a changed or invalid cursor receives current state, not a historical backlog.
- The projection uses indexed message/tool buffers on the backend, not the client's clone-per-event reducer. JSON Patch updates keep state and generated UI. The browser installs the snapshot in one mutation; historical notifications and tool-start side effects are not reissued. Loading ends at the snapshot checkpoint even while a run continues.
- Idle hydration finishes Core's connection lifecycle before a waiting submission is released, and hydrated prompt status takes precedence over cached statistics, so an old suspended prompt cannot turn a new branch submission into steering input.
- The pinned Core adaptation gives explicit local agents precedence over discovered proxies in both module formats.
- **Cursor replay for legacy clients.** Delivered events carry an opaque cursor: a per-thread, per-backend log generation plus sequence. A connect with a valid retained cursor reads only newer rows; a backend restart, a log rebuild or a compaction that removes the cursor row forces a full refresh. Replay and joining a live run stay synchronous with log appends.
- `ThreadReplayCacheStore`, an NgRx signal store, keeps visited messages, AG-UI state, pending interrupts and derived transcript state. During reconnect the transcript draws its cached messages while CopilotKit clears and restores its agent; outside reconnect the active agent's signals still give optimistic local updates.
- CopilotKit's proxy agent, run, stop and interrupt lifecycle stay. `ThreadReplayAgent` customizes only the history transport and restores a cached snapshot once before the reducer starts; it never sends cached history in the connect request or restreams cached messages through the reducer.
- A cursor is committed to the cache only after the serial event reducer applied its event. Client-only checkpoint markers are inserted after AG-UI validation, including after terminal events. An unchanged delta with a pending question restores control state locally; cached messages are not replayed.
- Inactive cache entries live 15 minutes with no thread-count cap; leaving a thread starts its idle period, and the selected thread never expires. Every 30 seconds expired entries are evicted, and inactive entries are evicted when Chromium's JS heap exceeds 80% of its limit or a host `memorypressure` event arrives (renderer heap pressure, not OS memory pressure).
- After 150 ms the transcript shows a conversation shimmer when no messages are available, or a small syncing indicator after the visible cached transcript, honouring reduced-motion preferences.
- **Virtual transcript.** The transcript exposes the complete redacted history to a variable-height viewport that owns history visibility; there is no manual history window, sizing policy, expansion action or graph percentage fallback. TanStack Virtual owns ranges, row offsets and the size cache; only visible rows plus overscan are mounted, spacers keep the scroll range, and rows that supply only backing activity state are omitted.
- Row rendering, batched height measurements and scroll correction commit in one transaction before paint; ResizeObserver invalidations use the same transaction on the next animation frame. Visited threads keep their measured heights and exact visible message/offset for fifteen minutes and restore that position before paint on revisit.
- New threads open at the end. **Latest** pins the viewport to the measured end, including later height changes; upward navigation releases following, downward wheel input and typing in the composer keep it, reaching the end resumes it. During a native scrollbar-thumb drag the scroll range stays fixed with mounted coverage expanded for short rows; the release restores the held message against updated measurements on the next frame. CopilotKit's automatic mutation scrolling is disabled; its scroll container, message/tool components, composer and Latest button stay in use.
- An opaque composer/footer cover hides transcript content behind the input and leaves the native scrollbar lane clear; the overlay lets pointer events through outside its controls.
- The desktop main process loads a small allowlisted UI-preference cache before renderer bootstrap and migrates existing localStorage preferences once in a hidden renderer, excluding credentials and backend tokens; the chat renderer reads the memory cache and writes through asynchronous IPC. Browser development keeps the localStorage fallback. Initial redaction prepares the snapshot cooperatively in short work slices with a bounded exact-value cache, and chat bootstrap is deferred from the shell.

## Consequences

- A cold client needs no cache and no replay: it receives one snapshot and then live deltas, and the stored AG-UI log stays unchanged.
- Switching back to a visited thread reads no history rows when nothing changed; a repaired log keeps one complete snapshot instead of thousands of chunks.
- Pending questions survive a reconnect without a second replay, because control state is restored from the cache when the delta carries no terminal event.
- The replay cache is renderer memory only; a legacy client still pays a full replay on a cold start, a backend restart or a log rebuild.
- A thread of thousands of messages mounts a few dozen rows; scroll position, thumb drags and Latest behave like a native list.
- Two transports coexist until legacy clients are gone: cursor-based delta replay and hydration.
- Transport changes need a real Core discovery test rather than an isolated subclass test, because discovery can silently replace the agent.
