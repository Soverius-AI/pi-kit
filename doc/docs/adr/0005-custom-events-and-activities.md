# ADR-0005: Extend AG-UI with Custom events for signals and Activity for surfaces

Status: Accepted
Date: 2026-10-15

## Context

pi emits things AG-UI has no first-class event for: compaction start/end, queue changes
(steer/follow-up), retries, model and thinking-level changes, tree leaf changes, extension
`notify` / `setStatus` / `setWidget`, usage and cost. AG-UI provides `CUSTOM { name, value }` for
protocol extensions and `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA { messageId, activityType,
content | patch }` for stateful surfaces in the transcript, the mechanism MCP Apps and A2UI use.
The spec asks teams to document their custom events.

## Decision

- Fire-and-forget signals are `CUSTOM` events with names prefixed `pi.`:

  | name | value |
  |---|---|
  | `pi.compaction` | `{ phase: "start" \| "end", tokensBefore?, tokensAfter? }` |
  | `pi.queue` | `{ steer: number, followUp: number }` |
  | `pi.retry` | `{ attempt, maxAttempts, reason }` |
  | `pi.model` | `{ provider, modelId, thinkingLevel }` |
  | `pi.tree` | `{ leafId, changed: string[] }` |
  | `pi.status` | `{ text }` (extension `setStatus`) |
  | `pi.notify` | `{ level, text }` (extension `notify`) |
  | `pi.usage` | `{ input, output, cacheRead, cacheWrite, cost }` |
  | `pi.session_info` | `{ name }` |

- Stateful surfaces in the transcript are `ACTIVITY_*` events with own `activityType`s:
  `pi.widget` (extension `setWidget` payload), `pi.diff` (`{ path, hunks[] }` built from
  edit/write tool results) and `pi.bash` (`{ command, output, exitCode?, running }` streamed
  from the bash tool).
- Schemas live in `libs/protocol` as zod objects and are the single definition for both sides.
- Extension dialogs (`confirm`, `select`, `input`, `editor`) are not custom events; they are
  AG-UI interrupts, so CopilotKit's human-in-the-loop handling applies.

## Consequences

- The renderer registers one activity renderer per `activityType` through
  `registerRenderActivityMessage`.
- Adding a pi feature to the UI means: add schema in `libs/protocol`, emit in `libs/pi-adapter`,
  render in `apps/renderer`. Nothing else.
