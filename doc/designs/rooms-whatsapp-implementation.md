# Rooms personal assistant implementation

Implemented on `feature/rooms-whatsapp`, 2026-11-23. This follows the [phone-channel research](rooms-phone-channels.md) and [linked-folder design](rooms-linked-folders.md).

## Create and use a room

Choose **Rooms → New room** and enter its name and purpose. A room needs neither Git, a folder, an existing thread, nor a playbook. Starting from a non-Git thread also works. Git remains necessary for coding workers and their isolated worktrees.

Open **Room panel → Assistant** to manage:

- **Memory:** remember, correct or forget room facts. Facts persist across sessions and restarts and stay scoped to their room. The lead can use `room_note` or `room_assistant` without a playbook; every turn receives current facts.
- **Commitments and routines:** create a due commitment or daily check, complete/cancel it, or snooze it. Revisions invalidate obsolete queued work and pending phone reminders.
- **Proactive mode:** opt in, choose an IANA timezone, quiet hours, daily phone-update limit and daily autonomous-run limit. New personal rooms start with proactive work disabled. Existing selected playbooks retain their configured behavior. The host must be awake and running pi-kit.
- **Linked folders:** attach approved host folders through named read-only links. Leads and local consultants keep a stable room cwd. Missing or retargeted references become unavailable without preventing independent assistant work; they never receive a replacement grant automatically. Removing a link preserves target files.
- **Uploads and outputs:** download incoming attachments and generated reports. The lead can save generated files with `room_assistant` while reference folders remain read-only.
- **Work:** see queued, running, completed, failed or interrupted turns. Interrupted effects require review before an explicit retry.

The sandbox grants canonical read-only reference roots, protects app metadata and managed link/upload/output directories, and revokes grants at a turn boundary. Actual macOS sandbox tests verify reads, denied writes, denied credential access and symlink confinement. Read-only linked-folder grants are explicitly unavailable in the Windows sandbox. Remote environments require their own approved local folders; a symlink is not file synchronization.

## WhatsApp onboarding and conversation

1. Expand **WhatsApp** and connect your own account or a dedicated assistant account by scanning its QR from WhatsApp's **Linked devices** screen.
2. With your own linked account, use a private group for the room; the agent replies under your account. With a separate assistant account, create a group containing the owner and assistant. Request a link code, send the displayed command yourself, then confirm the detected group and sender in pi-kit. Codes expire after ten minutes; display names alone do not verify identity.
3. Choose **Send connection test**. Reply with its exact command from the authorized owner account. The UI records a verified round trip separately from socket connection state.
4. Optionally save the HTTPS address from private access settings. Phone messages can then open their room through a stable link.

The panel expires stale link codes and shows aggregate receive timestamps for all groups on the linked account, without storing message content in diagnostic logs. Group-name lookup is bounded so missing metadata cannot block a link request. History synchronization is disabled because Rooms admits live input only.

Each confirmed group belongs to one room. Other senders, direct messages and a newly linked account cannot inherit that room's authority. Manual messages from the linked account can authorize and use its own room. Persisted outgoing provider IDs suppress pi-kit's own echoes, including after retries and restarts; same-account input bypasses the Chat SDK's self-message exclusion. Everyone in the group can read delivered content.

Text, supported images, voice notes and documents enter a durable inbox. Attachments are bounded and stored under the room's inbox. Audio uses the existing local speech service; if it is unavailable, the audio remains saved and the lead is told explicitly. Plain text/JSON documents are included in context; other document formats remain downloadable files. Quoted replies retain their room/work reference.

Questions and drafted actions include expiring, owner-only commands. Bare “yes” never approves an arbitrary action. Oversized previews require the full app. Stale or already-consumed requests cannot execute again. Phone commands include `/memory`, `/remember KEY: FACT`, `/forget KEY`, `/done ID`, `/snooze ID ISO_DATE`, `/pause`, `/resume`, and `/pending`.

Pausing holds work and normal delivery; control acknowledgements remain available. Unlinking revokes the binding. Disconnecting stops the assistant account for all rooms while retaining its credentials; unlink the device in WhatsApp to revoke those credentials.

## Durability and dependency choices

Owner input, agent wake-ups and scheduler/poll events share persistent room work records. Source keys deduplicate acceptance. Poll acknowledgements commit with queued work, including items beyond the first five. Commitment due-time advancement commits with its wake-up.

Phone results use a separate persistent outbox, stable provider IDs, bounded retries and delivery/read receipts. Quiet hours and daily caps hold proactive updates while direct replies retain priority. Unchanged internal checks do not create phone messages. Restart recovery preserves pending input and flags uncertain agent effects for review; it does not promise exactly-once external actions.

Pinned `chat@4.24.0`, `@chat-adapter/state-memory@4.24.0`, `chat-adapter-baileys@2.1.0`, and `baileys@7.0.0-rc14`. A checked-in adapter patch exposes connection callbacks, receipts, stable-ID text sends and bounded media streaming. The newest Chat SDK interface is incompatible with this adapter's reply method, so upgrades require compatibility checks.

SDK memory state is transient transport bookkeeping. Room identity, memory, pending work and deliveries live in SQLite. Baileys auth files live in the protected `<dataDir>/room-whatsapp-auth` directory with restricted permissions; this is local file storage rather than encrypted keychain storage. Protocol logging is suppressed.

## Validation and account setup

Backend room/assistant/phone/protection tests, Angular sidebar/data/component tests, production builds, generated API checks and actual macOS sandbox tests pass. Browser checks exercise standalone room creation, independent memory editing/reload, and responsive panels.

Live QR pairing has established a connected account during acceptance testing. Own-account group ingestion and the phone round trip are still being verified; socket connection alone does not prove delivery. The user must confirm the group and complete the built-in connection test. Voice transcription likewise requires a configured local speech model. Signal remains an alternative transport from the research, not part of the selected WhatsApp implementation.
