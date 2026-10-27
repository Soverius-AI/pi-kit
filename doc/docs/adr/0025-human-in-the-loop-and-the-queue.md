# ADR-0025: Human-in-the-loop blocks, message toolbars and the queue bar

Status: Accepted
Date: 2026-10-16

## Context

pi talks to a host through `ExtensionUIContext`. Four calls are dialogs that wait for an answer: `select`, `confirm`, `input` (each with `signal` and `timeout`) and `editor`. `notify`, `setStatus`, `setWidget` and `setTitle` are fire and forget. `custom`, `setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput` and the other TUI methods are terminal components and cannot be shown.
pi's dialogs are AG-UI interrupts, not tool calls: CopilotKit's `registerHumanInTheLoop` renders a frontend tool the model calls, while `injectInterrupt` lists and resumes interrupts.
pi does not surface MCP elicitation: its MCP client declares only the `roots` capability and nothing handles `elicitation/create`.
Every way pi asks must be an interactive block, the message toolbars must do what their labels say, and the queue of messages waiting for the running turn must be visible and editable. pi has no call that edits a queued message: `clearQueue()` empties both queues and returns the texts, `steer()` and `followUp()` add one.

## Decision

- Dialogs go through `injectInterrupt` (`ChatStore.interrupt`); nothing is registered with `registerHumanInTheLoop`. Every dialog is an `Interrupt` of kind `pi.ui.<method>`; `PiDialogRequest` carries title, message, options, placeholder, prefill, `source` (the extension), `tool` (the tool call that was running) and `timeoutMs` / `expiresAt`. The terminal-only methods are no-ops that resolve `undefined`, as in pi's own RPC mode.
- `pk-interrupts`, drawn at the end of the thread, lists the pending interrupts and switches on the method. One component per kind shares a `DialogBlock` base (request, timeout line, answer and dismiss outputs, focus on draw), all drawn with `PkApproval`, the design system's warning block.
- confirm: Allow / Deny; Enter allows, Esc denies; Enter is ignored for 400 ms after the block appears, so the key that sent the message cannot answer the question. select: options as full-width buttons numbered 1 to 9, the first highlighted as the default; arrows, Home and End move highlight and focus together; Enter or a number picks, Esc cancels. input: a single-line field with pi's placeholder; an empty answer is refused with a `role=alert` message. editor: a multiline monospace textarea with pi's prefill; Enter is a newline, ⌘⏎ (Ctrl+⏎ elsewhere) submits, Esc cancels.
- Every block says who asked: "Asked by an extension · <name> · while running <tool>". `UiBridge` names the extension from the call stack (`extensionNameFromStack`: the first frame under an `extensions/` folder, named as the settings list names it) and the tool from the session's `tool_execution_start` / `_end` events. A dialog opened by pi's own code shows only "Asked by an extension".
- Cancel resolves with the interrupt's `cancelled` status, which becomes `false` for confirm and `undefined` for the others; Deny and Esc on confirm answer `{ confirmed: false }`.
- pi's `timeout` is not enforced while nobody watches: an approval that expires silently is worse than one that waits. The request carries `timeoutMs` and `expiresAt` (epoch ms from the moment the extension asked, so a reload keeps the countdown); a block that is shown counts down on `ClockStore`'s tick and answers "cancelled" for the user at zero, with a notice.
- Questions in prose: when the newest answer ends in a question, nothing is running and no dialog is open (`ChatStore.proseQuestion`), the composer's placeholder and hint row say so and the suggestion pills start with Reply (focuses the composer) followed by one pill per listed option, which sends it. `endsWithQuestion` and `replyOptions` (`libs/protocol/src/prose-question.ts`) are heuristics that err toward showing no pill. `ThreadSummary.waiting` is "a dialog is pending, or the open session's last message ends in a question and nothing is streaming" (`PiSessionService.askedAQuestion`).
- Message toolbars: Copy puts the message's markdown source, or what the user typed, on the clipboard; Regenerate re-prompts from the parent turn and the sibling shows in branch navigation; thumbs show their state, replace each other and clear on a repeat; read-aloud is not drawn.
- Queue event: `queue_update` maps to `pi.queue { steer, followUp, steerTexts, followUpTexts }`; the counts stay for older logs.
- The bar is pi's queue: `ChatStore.queue` follows `pi.queue` and is read again from `GET /api/threads/:id/queue` after a replay and after every action, so a reload shows what pi holds.
- `pk-queue-bar` docks onto the well above the composer: a "Queued" header with the count, the delivery rule, Merge and Clear all; one row per message with a kind chip, Steer now (follow-ups only), Edit and Remove. Steering rows come first, then follow-ups, in delivery order. On a phone the rule is a tooltip and the actions open under the row.
- Actions are `POST /api/threads/:id/queue/{promote,remove,merge,clear}` (`QueueController`, `SessionQueue`). Every edit is clear, then queue what stays, in order: Steer now moves a follow-up behind the messages already steering; Remove leaves it out; Merge is one `steer()` with every text joined by blank lines (follow-ups only become one follow-up); Clear all is `clearQueue()`; Edit removes and puts the text in the composer. `promote` and `remove` name the message by list, position and text; a mismatch is 409 and the bar re-reads pi's queue. Edits run one at a time per session; a new message waits for edits requested before it.
- `SessionQueue` owns per-position attachment records beside the SDK's text queues, reconciled from the SDK's append and drain events; `AsyncLocalStorage` carries each send's attachments and queue kind through pi's input handlers to its own append event. Merge concatenates images in delivery order. Requeued messages keep `source: 'extension'`.

## Consequences

- `PiDialogRequest` and `pi.queue` grew optional fields; old logs and old clients keep working, and the earlier confirm and select tests run unchanged.
- A dialog that pi's own code opens cannot be attributed; the stack read is a heuristic that never throws and could miss a bundled extension without an `extensions/` folder.
- Auto-answering at the timeout happens in the renderer: a client that is not watching leaves the dialog waiting, and a window open on another thread answers when its thread is shown.
- Merge and Steer now re-run pi's queueing of a message; an extension that rewrites input sees the re-queue.
- The SDK has no atomic batch edit, so its own delivery can progress during a re-queue; an input held by an extension input handler is not in the queue until released, so it can arrive after a Clear. Images an extension queues outside pi-kit's input API are not tracked.
- MCP elicitation has no path until pi declares the capability; when it does, the mapping is a schema-to-fields function in `UiBridge` onto these blocks.
- A turn an extension starts with `pi.sendUserMessage` after its command returned has no run attached and neither streams nor logs until the session is read again.
