# ADR-0021: CopilotKit Angular components first, daisyUI theming, pi-kit slots

Status: Accepted
Date: 2026-10-16

## Context

`@copilotkit/angular` ships a composable chat whose every part accepts a component or template: `CopilotChatView`, `CopilotChatMessageView`, assistant, user and reasoning messages, suggestions, attachments, `CopilotChatInput` with slots, `CopilotChatConfiguration` for labels, `CopilotSidebar` and `CopilotPopup`. The one unusable piece is `CopilotThreadsDrawer`, whose store is bound to CopilotKit Intelligence.
Owning parallel components means re-implementing what CopilotKit ships and improves, off the path other CopilotKit users walk.
The app should look like one daisyUI product, and the composer needs features CopilotKit's input lacks: a `/` command menu with pi's skills, templates and built-ins, `@file` completion, steer/follow-up mode and image paste.
CopilotKit's message view draws one element per message, while pi-kit groups a turn into one block with steps and folds; the tool-calls view hands a renderer the call but not its id.

## Decision

- Tailwind v4 and daisyUI v5 style all owned UI. The theme pair is one light and one dark daisyUI theme, switchable; Electron reports the OS preference as the default.
- CopilotKit's component is the default for every chat surface; pi-kit adds a slot only where pi has something CopilotKit does not, and styles everything with tokens and daisyUI classes. This replaces the headless-only approach with pi-kit's own transcript and composer components.
- CopilotKit's stylesheet is not loaded; its components render with their class hooks and one block of pi-kit's `components.css` styles those hooks with tokens. Where a slot cannot reach something, the gap is worked around inside the slot, never with a parallel component.
- `pk-chat` holds the breadcrumb strip and `CopilotChatView`; `PkChatState` is CopilotKit's `ChatState` and only translates to `ChatStore`; labels come from `provideCopilotChatLabels`, all strings from one place, sentence case.
- The message list is `CopilotChatMessageView` with pi-kit templates for user, assistant, reasoning (`pk-think`: live line, "Thought for Ns", tokens only in the usage line) and cursor; `pk-prose` (marked + highlight, code copy) is the markdown renderer. `indexTurns` (`libs/ui`, pure) maps transcript blocks onto messages: turn spacing, which answer carries the toolbar, the step index, and a fold past six tool calls. Pieces with nothing to draw are not drawn.
- Tool calls use `CopilotChatToolCallsView` with `registerRenderToolCall` (read, edit, bash and default renderers): one view per call with a synthetic single-call message inside an element carrying `[pkToolCall]="call.id"`; the wrapper draws the step line and the fold.
- The usage line, markers, `!command` blocks, A2UI and MCP Apps are `registerRenderActivityMessage` renderers; one `pi.turn_usage` draws per block with the block's sum. Generated UI renders in a scoped container so its styles do not leak.
- The composer is `CopilotChatInput` with the `textArea` slot (`ComposerField`) and the `toolbar` slot (`ComposerToolbar`: tools menu from the command registry, registered actions, the Steer / Follow-up switch, the meter, Stop and Send). The input container declares `copilot-chat-view-input-container` as its selector so the view measures it. Enter goes through `ChatStore`'s send pipeline, not CopilotKit's `send()`.
- `copilot-chat-attachment-queue` shows pasted or dropped images and the draft's `@path` chips; `copilot-chat-suggestion-view` shows "Rerun last", templates flagged `suggested: true` and extension pills while idle with an empty draft; drag and drop goes through `PkChatState`. `CopilotChatAudioRecorder` with `transcribeAudio` backed by Whistle gives voice input.
- `ComposerExtensions` holds the registries: `registerComposerAction`, `registerInputTransform` (the ordered send pipeline: `!cmd` 10, built-ins 20, branch commit 30, `@file` 40; a transform rewrites, handles or refuses), `registerCompletionProvider` (`/` 10, `@` 20, extension arguments 30) and suggestions. A registration lives with its injection context.
- pi extensions reach the composer without touching the renderer: `ctx.ui.addAutocompleteProvider` is served by `POST /api/threads/:id/complete`; `pi.events.emit('pi-kit:composer', { op, id, ... })` is validated, relayed as the AG-UI custom event `pi.composer`, logged for replay and served by `GET /api/threads/:id/composer`.
- The assistant toolbar keeps copy, regenerate and thumbs; read-aloud is not registered. Thumbs are the `feedback` table behind `GET`/`PUT /api/threads/:id/feedback`; the same rating again clears it. Regenerate navigates to the turn's user message and prompts the same text again; the new turn is a sibling. Edit on `CopilotChatUserMessage` is edit-and-branch; branch navigation is CopilotKit's `branchIndex` / `numberOfBranches`, fed by the session tree's sibling turns.
- Interrupts use `registerHumanInTheLoop` / `injectInterrupt` for the approval block.
- The runner sends the end-of-run `MESSAGES_SNAPSHOT` to live clients, so provisional ids become pi entry ids; the store answers the snapshot with `{ messages, stopPropagation: true }`, so pi's history is the transcript's order.
- Past 1000 messages `ChatStore.drawnMessages` is the newest 400, starting at a user message; "Show earlier messages" widens it by 400 and the graph's click-to-scroll widens it to everything.
- Turn hover is a hot-turn class set from `mouseover` on `[data-turn]`; `data-block` and `data-after` are the graph panel's contract for tint and click-to-scroll. The de-clutter rules apply to the slots: no avatars, captions on hover.
- `CopilotSidebar` / `CopilotPopup` serve the attendant's drafts and quick asks, not the main window. The threads sidebar, session graph, files, changes, terminal, settings and onboarding are pi-kit components.
- Accepted gaps: the view's first scroll to the end is smooth; the breadcrumb strip sits above the view rather than in `messageViewChildren`; the empty state is a `messageViewChildren` template with `hasExplicitThreadId`.

## Consequences

- An activity type nobody registered draws nothing; a new `pi.*` activity must be registered to show.
- A user message streamed in this window shows branch navigation only after the run's snapshot and the next tree fetch.
- A template key handler must return nothing: Angular cancels the event when it returns `false`.
- The initial bundle grows, because `@copilotkit/angular` is one module that brings `highlight.js` and `katex` in full.
- Branch navigation on user messages gives the session tree a second, in-place entry point.
- `ChatStore` is large; its pure parts live in `libs/ui`.
- Less UI code than parallel components, in exchange for working inside CopilotKit's slots and class hooks.
