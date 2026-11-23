# Room messaging channels and BotFather onboarding

Implementation and research: 2026-11-23, `feature/rooms-whatsapp`.

## Implemented channels

Rooms has three separate messaging panels. Each distinguishes connecting an assistant identity, linking a conversation to a room, and verifying a reply from the owner. Account connections are shared across rooms on their host; conversation bindings, authorized senders, link challenges, inboxes, outboxes, command tokens and send ledgers are scoped by provider. Disconnecting a provider affects all rooms using it; unlinking affects one room binding.

One `RoomPhoneService` implementation runs for each provider through `RoomChannelRegistry` and the `RoomMessagingTransport` contract. Migration `0022` copies existing WhatsApp records into channel-scoped tables. Existing `/rooms/:roomId/phone` endpoints remain WhatsApp aliases. New clients use `/rooms/:roomId/channels/:channel`. SDK memory is temporary transport state; room memory and delivery state remain in SQLite.

| Channel | SDK | Provisioning |
| --- | --- | --- |
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

## BotFather findings and proposed Telegram follow-up

Telegram is a strong next option for personal assistant onboarding: a bot is a dedicated identity created through BotFather, without registering another normal messaging account for the assistant. Classic setup uses `/newbot`, a bot name/username, and a revocable token. Users can then add that bot to a group. This is the useful product pattern: provision the identity once, then bind its conversations to rooms.

**Vercel Chat SDK supports the classic BotFather flow.** Its official `@chat-adapter/telegram` accepts a bot token, supports groups, inline buttons, commands and local long polling. A local pi-kit host therefore would not require a public webhook. Inspection of published 4.44.0 and latest 4.45.0 packages confirmed these capabilities.

**Managed-bot onboarding is a separate gap.** Telegram now supports management bots: enable Bot Management Mode, open `https://t.me/newbot/MANAGER/NEW_BOT?name=NAME`, receive a `managed_bot` update, then obtain the new bot's token with `getManagedBotToken`. Neither inspected adapter version handles `managed_bot` updates or exposes those token-management methods. Its protected `processUpdate` and `telegramFetch` extension points could support a small dedicated extension; this is not turnkey SDK support. A manager identity and securely stored manager token would still need initial setup.

Recommended future flow:

1. **Create or connect assistant:** initially accept a BotFather token through the OS credential store. Offer managed creation only once the manager and update/token lifecycle are implemented.
2. **Add this room:** use a group-selection deep link with a short-lived opaque room challenge. Telegram's `startgroup` payload arrives as `/start@BOT PAYLOAD`; adapt it to the existing challenge/owner-confirmation flow. Do not expose room secrets in the URL or assume a group name proves ownership.
3. **Verify and operate:** confirm the numeric bot/chat/sender identities, complete the existing reply test and show commands for memory, pending work, pause and resume. Telegram commands use underscores rather than the hyphenated internal command names. Apply quiet hours, explicit approval tokens and the shared durable room workflow.

Group privacy settings need deliberate setup: Telegram privacy-mode bots do not receive every ordinary group message. Use explicit commands/mentions and replies by default, or explain the privacy-mode change when the owner intentionally wants all room conversation input. A dedicated group per room is the first mapping; topic-per-room routing would need explicit topic identifiers in durable bindings.

Telegram is researched here, not implemented in this change. Rooms currently supports WhatsApp, Signal and Slack.

Sources: [BotFather tutorial](https://core.telegram.org/bots/tutorial), [official Telegram SDK adapter](https://chat-sdk.dev/adapters/official/telegram), [managed bots](https://core.telegram.org/bots/features#managed-bots), [group deep links](https://core.telegram.org/bots/features#deep-linking), [privacy mode](https://core.telegram.org/bots/features#privacy-mode).

## Validation boundary

Automated tests exercise the actual installed adapters with fake sockets/processes, channel isolation, migration preservation, owner authorization, durable intake and restart behavior. The local signal-cli version and empty-profile JSON-RPC/shutdown path were also checked. No Signal/Slack account has been paired or messaged during this implementation. User account setup and the built-in connection test remain necessary for live acceptance.
