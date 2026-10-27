# ADR-0031: Agent-authored A2UI and Open Generative UI, with standard AG-UI interrupts

Status: Accepted
Date: 2026-10-18

## Context

pi-kit renders A2UI tool results and MCP Apps, but pi never receives CopilotKit's frontend tools or generation context, so an ordinary request for a chart has no built-in way to display it inline. CopilotKit Angular 0.6.0 ships an Open Generative UI renderer backed by `@jetbrains/websandbox` that is unused, and its stock `srcdoc` iframe cannot run under the desktop renderer's `script-src 'self'` CSP.
pi's extension dialogs already map to AG-UI interrupt outcomes and resume entries, but the agent has no bundled question tool, interrupts lack the standard response schema and tool-call correlation fields, and a stopped run is marked successful with a private `result.aborted` flag.

## Decision

- `render_a2ui`, `generateSandboxedUi` and `ask_user` are built-in pi extension tools in every session, including resumed ones. Browser-provided tools and context are not forwarded to pi; CopilotKit's A2UI tool injection and frontend catalog-schema injection stay disabled.
- `render_a2ui` takes a surface id, title, body component id, component definitions and an object data model, validates ids and child references, and supplies the framed root Card, catalog id and A2UI v0.9 operations. Results use `details.a2ui_operations`; CopilotKit's catalog renderer and action bridge render the interface and callbacks.
- `generateSandboxedUi` uses CopilotKit's tool name and HTML/CSS/JavaScript contract. The runtime's Open Generative UI middleware and Angular's `openGenerativeUI` option are enabled; the middleware streams `open-generative-ui` activities, a completed tool stores its arguments in `details.open_generative_ui`, and the adapter emits and reconstructs the completed activity under `<toolCallId>-activity`. Transcript grouping recognizes it; log compaction removes superseded activity patches.
- `pi-ui/SKILL.md` ships the routing, tool contracts, data handling, supported A2UI properties, actions and a Git commit-chart recipe. It loads through `additionalSkillPaths`, is listed in Settings, and pi's `before_agent_start` system-prompt section carries short capability guidance.
- `ask_user` awaits pi's `ctx.ui.select` or `ctx.ui.input` promises over the same interrupt/resume path as extensions. Cancellation is an unanswered question, not an answer.
- WebSandbox under the desktop CSP: CopilotKit's renderer and JetBrains' RPC runtime stay, with a loader whose WebSandbox subclass loads `/api/genui-sandbox/frame.html`, a credential-free bootstrap. The parent sends the prepared document after a source-checked ready handshake; no token, path or generated HTML appears in the URL or response. The iframe has only `sandbox="allow-scripts"` (opaque origin); the bootstrap's own CSP allows no connections, nested frames, objects, forms or base URLs, allows inline scripts and styles, and pinned libraries from jsDelivr or unpkg. No host functions are registered. A source-checked resize message, bounded to 100–2000 px, follows late layout.
- AG-UI compatibility: `getCapabilities()` advertises streaming, resumability and human-in-the-loop interrupts; client-provided tools remain unsupported. Interrupts carry the standard `responseSchema` and optional `toolCallId` beside pi's dialog metadata. pi's client-owned timeout deadline stays in metadata, and after it the UI resumes the waiting extension with `status: cancelled`; a hard `expiresAt` is not used because the SDK would discard that required resume.
- An interrupt ends the AG-UI run while pi still owns the live prompt: its checkpoint is recorded, but the streamed question and tool state are preserved while pi streams or has pending dialogs. Reconnect, file reconciliation, branch publication and idle compaction respect that ownership; unattached toolbar registrations wait until the resumed run starts; tree navigation stays blocked until the prompt is answered, cancelled or stopped.
- A resume batch is validated as a whole before any waiting promise settles: duplicate ids, ids without a pending dialog, wrong answer types and unavailable select options are rejected. Object answers and scalar values are both accepted. A partial resume re-advertises unanswered dialogs.
- A stopped run uses `RUN_FINISHED.outcome.type = cancelled` and retains `result.aborted`; readers accept both. Extension toolbar events that arrive while middleware delays `RUN_STARTED` are queued so they follow the start in the live stream and in the replay log.

## Consequences

- An agent answers "show me a chart" inline without client-side tool plumbing, and the skill makes the capabilities discoverable before it is read.
- Generated UI stays confined to its iframe; general frontend tool execution and arbitrary host callbacks are outside this decision.
- Other AG-UI clients can drive pi's interrupts with scalar answers, and existing clients and logs still recognize stops through `result.aborted`.
- The session file alone cannot reconstruct pending dialogs; every path that rebuilds thread state must honour pi's ownership of a live prompt.
