# Rooms: mobile review and personal assistant direction

Reviewed 2026-11-23 against Soverius-AI/pi-kit main, `29e7fa0` (0.93.0).

Messaging follow-up: [Rooms through phone conversations](rooms-phone-channels.md) updates the WhatsApp/Signal and SDK recommendations below. It covers the separate personal WhatsApp Agent Platform, the owner's lack of access to it, and the group-per-room onboarding proposal.

The follow-up also includes [ideas from Vercel Board](rooms-phone-channels.md#ideas-from-vercel-board): persistent work items, reply routing, recoverable follow-ups and a view of work needing the owner's attention. The [linked-folder proposal](rooms-linked-folders.md) specifies the stable room workspace these items use.

## Recommendation

Keep Rooms as the durable home for a goal, its conversation, decisions, routines and results. Add a personal assistant room that can be reached from WhatsApp and the web, with opt-in proactive work and memory independent of a playbook. Playbooks become optional reusable routines inside that room. Cross-machine coding remains one capability of a room.

The runtime already supports much of this. The missing work is chiefly channel access, delivery, durable wake-up handling and an accessible setup experience. A WhatsApp tool connection alone does not make a room reachable from WhatsApp.

## What is implemented

| Capability | Evidence | Assessment |
| --- | --- | --- |
| Persistent shared conversation, tasks and run history | `apps/backend/src/rooms/room-lead.service.ts`, `room-runs.ts`, `rooms.controller.ts` | Reuse as the canonical history for every channel. |
| Scheduled and polling wake-ups | `room-playbook.service.ts`, `room-schedule.ts` | Genuine proactive execution exists; it runs in the backend without a browser window. |
| New-item detection | `RoomPlaybookService.poll`, `RoomPlaybooksRepository.unseen` | Persistent seen keys exist, but batching and acknowledgement need attention below. |
| Memory | `RoomPlaybookService.note`, `briefing`, `scopes` | Explicit key/value notes exist in room and repository/playbook scopes. This is narrower than personal assistant memory. |
| Approved and automatic outputs | `RoomPlaybookService.call`, `decide`, playbook schema | Draft approval is the default; configured automatic outputs can have call limits. |
| Composio tools | `mcp/composio/composio-connect.service.ts`, `RoomLeadService.composioLine` | Selected apps are described to the lead; it discovers tools through MCP. This does not register inbound event subscriptions. |
| Cross-machine execution | `room-a2a.*`, `room-tasks.service.ts`, `room-outbox.ts` | Existing coding-task transport and delivery should remain separate from human messaging channels. |
| Headless operation | `doc/designs/room-playbooks.md`, `doc/docs/server.md` | An always-on host is feasible; a sleeping desktop cannot deliver dependable proactive work. |

## Mobile findings and changes

Reproduced in Chromium at a 390 × 844 CSS viewport using an isolated backend, agent directory and test repository. No external account was connected and no model prompt was sent.

1. The Playbook/Tasks/Runs side panel opened by default and covered its only toggle. A real click on the toggle timed out because the playbook select intercepted pointer events. The panel had no independent close button, backdrop or Escape handler.
2. Its absolute positioning was not anchored to the room, so it covered the app header too.
3. The room toolbar overflowed horizontally on a phone. Bringing its toggle into view scrolled the main container sideways and clipped conversation text.
4. The playbook detail header gave its fixed-width actions priority over the title and description. At 390px, the description and file path collapsed into a nearly one-character column.

The accompanying patch adds a sticky panel header with a 44px close control, backdrop and Escape dismissal, a focus trap and inert conversation while the mobile drawer is open, and a closed initial state on narrow viewports independent of the desktop preference. Opening a playbook, run or task dismisses the mobile drawer. The drawer is anchored to the room; the phone toolbar and playbook detail header use layouts that fit the available width. The playbook dialog also handles Escape and traps keyboard focus.

Final browser checks passed at widths 320, 390, 768, 900, 901, 1024, 1280 and 1440px. Checks covered drawer close/backdrop/Escape behavior, keyboard focus containment and restoration, 44px close targets, playbook handoff, readable detail headers and horizontal overflow. The toolbar responds to the room column's width, including when both desktop sidebars are visible. All 24 room component tests, targeted lint, translation checks and the production renderer build passed. Existing Angular diagnostics outside Rooms remain warnings.

These browser checks establish responsive behavior, not physical iOS/Android keyboard, safe-area or screen-reader behavior. Those require device testing before calling mobile support finished.

Following the mobile width review, the thread sidebar, room panel and playbook details now use the full available width below 768px, with safe-area padding. Browser checks confirmed their widths and close controls at 320, 390, 430 and 767px, and preserved the tablet drawer layout at 768px. The production renderer build also passed after this adjustment.

## Gaps before dependable personal assistance

### A personal goal still requires a Git repository

`CreateRoomSchema`, `RoomsService.startIn` and `chooseClone` tie creation to a repository and base commit. That makes sense for coding but adds an unrelated prerequisite to “help me prepare for tomorrow.” Add a room purpose and an optional project attachment; keep base-commit/worktree requirements on coding tasks.

### Memory currently depends on a playbook

`room_note` calls `leadRoom`, which rejects a room without a playbook. Briefing notes are loaded with the playbook briefing. The UI displays a notebook but does not expose owner editing. There is no explicit personal profile scope, expiry, provenance or searchable recall interface here.

Make remember/show/edit/forget available without a playbook. Keep personal preferences separate from room-specific facts and reusable playbook lessons. Each saved fact should retain its source, scope and update time. Verify an actual write before acknowledging “remembered.” Keep conversation history and task progress separate from curated memory, and support a fresh session that recalls the same facts without replaying an indefinitely growing chat.

### Wake-ups need durable acknowledgement

Code inspection reveals two reliability gaps; restart fault injection was not performed in this review:

- `RoomLeadService.inbox` is an in-memory map. Schedule timestamps and polling seen keys are persisted before a nudge is processed. A crash between those operations can leave work acknowledged but not performed.
- `poll` marks **all** returned keys seen through `unseen`, then sends only the first five new items to the lead. A sixth unchanged item will not be offered on the next poll. A response-size limit should create batches/backlog, not consume unseen work.

Persist each wake-up with a stable event ID, payload and pending/running/completed state. Acknowledge individual batches after durable enqueue, recover pending work after restart, and deduplicate provider retries. Expose failed/retrying work and missed schedules in run history. Add explicit room timezone and catch-up behavior; cron currently uses the host's local timezone.

### Proactive execution and proactive delivery are different

Runs and room events already persist results, but there is no human-channel delivery service in Rooms. The A2A outbox delivers agent task updates to paired instances; it is not a WhatsApp notification outbox.

Add an owner-controlled proactive setting with schedules/events, quiet hours, daily notification and model-usage limits, pause, and “notify only on meaningful changes.” Record a channel-neutral result first, then deliver through a retryable outbox. Keep delivery IDs in the room so replying to a briefing continues the work that produced it.

### Connected Composio apps do not establish an inbound channel

The current Composio Connect path lists the selected tools for the lead. It does not map a WhatsApp sender to an owner/room, verify incoming message events, register subscriptions, deduplicate messages or route replies.

Implement a channel adapter with trusted account/sender bindings and explicit room selection. Do not select a room by asking the model to guess from a message. Give replies to a known notification their original room binding; provide a room chooser for a new conversation or an ambiguous switch.

## What to borrow from Hermes and Composio

Hermes provides a useful reference for messaging access, bounded persistent memory plus historical recall, and scheduled work. Its cron deliveries can optionally be mirrored into a conversation so the user can continue them; on a DM-only channel, the DM is the continuation surface. Its memory documentation also describes session-boundary and frozen-snapshot limitations. Copy the continuity behavior deliberately rather than assuming every channel/session automatically shares context.

Sources: [Hermes messaging gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging), [persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [scheduled tasks and continuable deliveries](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

Composio has a directly relevant Pi/Slack assistant example: inbound triggers wake an agent, tools are scoped to the user, and a shared bot connection handles delivery. Composio triggers deliver signed events and may be redelivered, so the application still needs identity checks and idempotent handling.

Sources: [Composio Pi assistant example](https://docs.composio.dev/examples/general-agent-with-pi), [triggers](https://docs.composio.dev/docs/triggers), [delivery semantics](https://docs.composio.dev/kb/guide/platform-triggers).

The [Composio WhatsApp toolkit](https://docs.composio.dev/toolkits/whatsapp) uses WhatsApp Business accounts, not personal accounts. Messages outside the 24-hour customer-service window require an existing approved template. Those are Business integration constraints; the separate personal Agent Platform and linked-device bridges have different setup and delivery behavior. See the [phone conversation follow-up](rooms-phone-channels.md) for the updated comparison and the owner's available options. The existing Composio connection does not itself supply a linked-device bridge.

Source: [Hermes WhatsApp Business setup and bridge comparison](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud).

## Use cases to prioritize

These are proposed product scenarios, not claims that the current application supports them end to end.

| Scenario | Room behavior | Memory that earns its place | Completion evidence |
| --- | --- | --- | --- |
| Morning briefing | Read approved calendar/email sources; deliver a concise brief at the owner's local time. | Working hours, preferred format, important projects. | Reply “prepare for the second meeting” from WhatsApp and continue the same room with the briefing in context. |
| Commitments and follow-ups | Track an explicit commitment; prompt when it becomes due or blocked. | Person/project, due date, status and source message. | Snooze, complete or correct it from either channel; no repeated reminder after completion. |
| Project watch | Watch GitHub/Linear changes; surface blockers and ask for decisions. | Accepted decisions, review standards, release context. | A burst of more than five changes is fully processed, including across a host restart. |
| Research watch | Monitor selected sources; compare with previous findings. | Prior conclusions, cited evidence and notification threshold. | Send a change summary with sources; a follow-up question retrieves the previous comparison. |
| Meeting preparation | Create a brief before a meeting and draft follow-up actions afterward. | Relevant participants and unfinished actions scoped to that project. | External writes remain drafts unless that specific routine was authorized for automatic execution. |

Start with morning briefing plus commitments. They exercise channel continuity, scheduling and memory with a clear daily benefit. Use the existing Composio tools for sources where suitable. Add project watch once event recovery and batching are reliable.

## Suggested delivery sequence

1. **Mobile reliability:** ship the panel/layout fix and verify on physical phones, including rotation, the software keyboard and long playbook names.
2. **Core assistant room:** allow non-Git rooms; provide basic memory controls; make wake-ups durable and fix polling acknowledgement/batching.
3. **Phone conversations:** follow the updated [messaging plan](rooms-phone-channels.md): for the owner's current account, evaluate QR-linked WhatsApp groups or Signal groups with explicit room bindings. Treat Business Cloud and the personal WhatsApp Agent Platform as separate transport choices with different onboarding and limits.
4. **Proactive routine:** one morning brief and commitment reminders with quiet hours, notification limits and delivery status. Add more routines after this complete loop works.

Release acceptance should cover duplicate inbound messages, replying to a proactive delivery, corrections to remembered facts, restart recovery, expired tool authentication, blocked outbound delivery and pause/resume. A successful run is not proof that a notification arrived.
