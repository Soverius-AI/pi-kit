# ADR-0002: AG-UI over SSE, hosted by the open-source CopilotKit runtime

Status: Accepted
Date: 2026-10-15

## Context

The chat needs generative UI (A2UI), MCP Apps and human-in-the-loop. CopilotKit implements all
three on its AG-UI protocol and ships a first-party Angular package (`@copilotkit/angular`).
AG-UI's event model (run lifecycle, text, tool calls, reasoning, state, activity, custom) maps
cleanly onto pi's session events. CopilotKit documents two ways to reach a custom AG-UI backend
from Angular: `agents` (dev only) and `selfManagedAgents` (Enterprise licence). A third way,
used by CopilotKit's MIT project OpenDots, is to host `CopilotRuntime` from `@copilotkit/runtime`
and register an `AbstractAgent` subclass in its `agents` map; the frontend then uses
`runtimeUrl`. None of that needs a licence.

## Decision

- Transport: AG-UI over SSE, served by `CopilotRuntime` mounted in NestJS at `/api/copilotkit`.
- `PiAgent extends AbstractAgent` implements `run(input): Observable<BaseEvent>`, `clone()` and
  `abortRun()`, mapping pi events to AG-UI events:

  | pi | AG-UI |
  |---|---|
  | run accepted | `RUN_STARTED` |
  | `message_update` text delta | `TEXT_MESSAGE_START/CONTENT/END` |
  | thinking deltas | `REASONING_*` |
  | `tool_execution_start/update/end` | `TOOL_CALL_START/ARGS/END/RESULT` |
  | extension UI dialog (`confirm`, `select`, `input`, `editor`) | interrupt (`RUN_FINISHED` with `outcome: interrupt`), resumed via `resume` on the next run |
  | `agent_settled` | `RUN_FINISHED` |
  | error / abort | `RUN_ERROR`; a user stop ends with `RUN_FINISHED` instead |
  | everything else pi-specific | `CUSTOM` or `ACTIVITY_*` |

- Anything that is not conversation (thread list, tree, commands, settings, files) is plain REST
  on the same Nest server, not AG-UI.
- The frontend uses `provideCopilotKit({ runtimeUrl })` and `injectAgentStore` only; no
  `HttpAgent` in the browser.

## Consequences

- The app depends on CopilotKit's open-source packages (`@copilotkit/runtime`,
  `@copilotkit/angular`, `@ag-ui/*`). Versions are pinned and upgraded together.
- `CopilotRuntime` exposes a fetch-style handler; if mounting it in Nest fails, the fallback is a
  Hono app in the same process on a sibling path.
- Reconnect and replay rely on the runtime's `AgentRunner`.
