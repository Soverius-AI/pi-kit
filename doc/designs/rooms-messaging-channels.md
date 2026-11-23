# Room messaging channels and BotFather onboarding

Implementation and research: 2026-11-23, `feature/rooms-whatsapp`.

## Implemented channels

Rooms has four separate messaging panels, with Telegram first for BotFather onboarding. Each distinguishes connecting an assistant identity, linking a conversation to a room, and verifying a reply from the owner. Account connections are shared across rooms on their host; conversation bindings, authorized senders, link challenges, inboxes, outboxes, command tokens and send ledgers are scoped by provider. Disconnecting a provider affects all rooms using it; unlinking affects one room binding.

One `RoomPhoneService` implementation runs for each provider through `RoomChannelRegistry` and the `RoomMessagingTransport` contract. Migration `0022` copies existing WhatsApp records into channel-scoped tables. Existing `/rooms/:roomId/phone` endpoints remain WhatsApp aliases. New clients use `/rooms/:roomId/channels/:channel`. SDK memory is temporary transport state; room memory and delivery state remain in SQLite.

| Channel | SDK | Provisioning |
| --- | --- | --- |
| Telegram | Official `@chat-adapter/telegram` 4.44, local polling | Create a bot with BotFather, then save its bot token in the room panel. No separate assistant phone number. |
| WhatsApp | Chat SDK 4.44 with community `chat-adapter-baileys` 2.1 and pinned Baileys 7 RC14 | Register a dedicated assistant account in WhatsApp, then scan the room panel QR from that account's Linked devices. |
| Signal | Chat SDK 4.44 with community `@stibbons/chat-adapter-signal` 0.1 | Create a dedicated account in Signal, then scan the linking QR. Local `signal-cli` 0.14.10 or newer is required. |
| Slack | Official `@chat-adapter/slack` 4.44, Socket Mode | Create a Slack app, install its bot, save app/bot tokens in the room panel, then connect. No public webhook. |

Create a group containing the owner and assistant for WhatsApp or Signal. For Slack, invite the bot to the intended channel. Request a room link code, send it from the owner's account, then confirm the detected conversation and sender in the paired Rooms UI. Slack uses literal `!room-link CODE` messages; it does not require registered slash commands. Signal and WhatsApp use `/room-link CODE`. Codes expire after ten minutes.

After linking, send a connection test and reply with its exact command. Only this reply marks the round trip verified; an open socket does not. Room memory, commitments, approvals and proactive policies are shared across the room's entry points. Proactive work remains opt-in, observes quiet hours and limits, and requires an awake host with pi-kit running. Model turns also require configured model credentials.

### WhatsApp

The own-account bypass is removed from the adapter and room routing. Assistant-authored messages cannot authorize or trigger room work. Legacy self-bindings cannot send or process queued work; unlink and relink using a separate owner account. The unofficial protocol remains experimental. Its protected local authentication directory is not the OS keychain.

### Signal and numberless accounts

`signal-cli` supports linking existing numberless Signal Login accounts using their ACI UUID. This is linked-device provisioning, not numberless registration through pi-kit. The documented primary registration path currently uses Signal's supported Android beta. Rooms never requests recovery keys or account passwords.

Install `signal-cli` on the room host (`brew install signal-cli` on macOS), or supply an absolute executable path in Signal settings. The panel probes its version when connecting and displays errors. Version 0.14.10 includes the fix for newer Android numberless link URIs. Profiles and settings use a protected local directory. Provisioning and runtime use bounded local stdio RPC, without exposing a public Signal HTTP service.

The community adapter patch adds stable timestamp sends and native quotes through its normal SDK pipeline. Signal currently reports successful sends, not delivered/read receipts. Genuine pending group messages remain eligible after reconnect; own sync and history events cannot trigger room work.

Sources: [signal-cli README](https://github.com/AsamK/signal-cli/blob/v0.14.10/README.md), [JSON-RPC provisioning](https://github.com/AsamK/signal-cli/blob/v0.14.10/man/signal-cli-jsonrpc.5.adoc), [numberless Android registration](https://support.signal.org/hc/en-us/articles/11197884108826-Phone-Numberless-Registration-for-Android-beta), [community Chat SDK adapter](https://chat-sdk.dev/adapters/community/signal).

### Slack

Use the checked-in [Slack app manifest](../../apps/backend/src/rooms/slack-app-manifest.json) to create an app, enable Socket Mode, install it into the workspace and create an app-level token with `connections:write`. Save its `xapp-…` and `xoxb-…` tokens in the Slack panel. The host's OS credential store must be enabled; plaintext fallback is rejected. Tokens are not returned through status responses or stored in SQLite. Invite the bot to each channel before linking.

Socket events are acknowledged only after durable admission, without waiting for model execution. Bot messages, DMs, other workspaces and unsupported event subtypes are excluded. Replies preserve their Slack thread root across restarts. Attachment downloads are authenticated, bounded and restricted to Slack file hosts. Stable UUIDs are passed as `client_msg_id`; uncertain sends still require review rather than promising exactly-once delivery.

Sources: [official Slack adapter](https://chat-sdk.dev/adapters/official/slack), [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

## Telegram through BotFather

Telegram is implemented with Vercel Chat SDK's official `@chat-adapter/telegram` 4.44 adapter. BotFather creates a dedicated bot identity; it does not require registering another normal messaging account for the assistant. One host connection can serve multiple rooms, with one group per room.

1. Open **Room panel → Telegram → Open BotFather**. Send `/newbot` in Telegram and choose a bot name and username. Keep the resulting token private.
2. Paste it into **Bot token from BotFather** in Rooms and save. The host verifies the bot and stores the token in its OS credential store. Enable credential storage in Settings first if necessary. No plaintext fallback or token in status responses.
3. Choose **Connect Telegram bot**. The panel shows the verified bot name and username. The connection uses local long polling; no public webhook or Vercel hosting is required. An existing webhook belongs to its existing integration and is not silently removed. Run each bot on one Rooms host; a host connection can serve multiple rooms.
4. Choose **Get a conversation link code**, then **Add bot to group**. Telegram's group selection opens with the bot and a short-lived challenge. Choose or create a group, complete Telegram's Add/Start action, then confirm the detected group and your personal sender identity in Rooms. The manual fallback is the displayed `/room_link@BOT CODE` command. A display name alone does not establish ownership.
5. Choose **Send connection test** and send its exact `/room_test@BOT TOKEN` reply from your personal account in that group. This marks a verified round trip separately from socket or polling state.

Telegram's default group privacy means ordinary text may not reach the bot. Reply to one of its messages or send `/room@BOT YOUR_QUESTION`. Addressed commands are the reliable entry under default privacy; a plain mention is not guaranteed to reach the bot. Send `/help@BOT` for usage. Controls include `/memory@BOT`, `/remember@BOT KEY: FACT`, `/forget@BOT KEY`, `/pending@BOT`, `/pause@BOT` and `/resume@BOT`. The common room workflow handles memory, commitments, approvals and proactive updates; the bot is an entry point into that room. Each group has one authorized owner. DMs, bot-authored messages and edited/history events cannot authorize room work.

Polling checkpoint and failed-update recovery use durable host state rather than transient SDK memory alone. A repeated update is admitted once by the canonical channel/room/provider ID. Changing the bot's username or rotating the same bot's token does not change its numeric identity; a different bot cannot inherit room authority. Unknown send outcomes require review, because Telegram does not provide a client-generated idempotency key. Successful sends are not reported as delivered/read receipts.

Telegram has a smaller message limit than the other channels. Complete approval previews must fit before actionable tokens are issued; oversized requests require the full room UI. Ordinary long replies use a bounded single-message preview. This avoids splitting a send into partially completed effects.

**Managed creation remains a separate follow-up.** Telegram's Bot Management Mode can create bots from a manager link and obtain their tokens through `managed_bot` updates and `getManagedBotToken`. The inspected Chat SDK 4.44/4.45 versions do not handle that flow directly. This implementation uses the supported BotFather token flow and does not require a manager bot.

Sources: [BotFather tutorial](https://core.telegram.org/bots/tutorial), [official Telegram SDK adapter](https://chat-sdk.dev/adapters/official/telegram), [bot accounts](https://core.telegram.org/bots#how-do-bots-work), [managed bots](https://core.telegram.org/bots/features#managed-bots), [group deep links](https://core.telegram.org/bots/features#deep-linking), [privacy mode](https://core.telegram.org/bots/features#privacy-mode).

## Validation boundary

Automated tests exercise the actual installed adapters with fake sockets/processes, channel isolation, migration preservation, owner authorization, durable intake and restart behavior. The local signal-cli version and empty-profile JSON-RPC/shutdown path were also checked. No Telegram, Signal or Slack account has been paired or messaged during this implementation. User account setup and the built-in connection test remain necessary for live acceptance.
