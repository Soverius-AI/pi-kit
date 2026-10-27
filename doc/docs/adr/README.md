# Architecture decision records

One record per architecturally significant decision, in the form Michael Nygard proposed: title, status, context,
decision, consequences. A record says what was decided and why, in the present tense, in under about sixty lines,
and stands on its own: it does not cite other records. It does not report how the work went: no build logs, test
counts, screenshots, phase or plan numbers, "as built" notes or dated appendices. Those belong in commits and in the
guides.

When a decision changes, the record is rewritten to state the decision as it now stands; git keeps the history. A
record that no longer decides anything is deleted and the others are renumbered.

Template:

```
# ADR-NNNN: Title

Status: Proposed | Accepted
Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```

| ADR | Title |
|---|---|
| [0001](0001-pi-as-the-agent.md) | Embed pi through its SDK as the agent engine |
| [0002](0002-ag-ui-over-copilotkit-runtime.md) | AG-UI over SSE, hosted by the open-source CopilotKit runtime |
| [0003](0003-pi-sessions-are-the-source-of-truth.md) | pi session files are the source of truth; SQLite holds UI metadata |
| [0004](0004-monorepo-angular-nestjs-electron.md) | Nx monorepo with Angular, NestJS and Electron |
| [0005](0005-custom-events-and-activities.md) | Extend AG-UI with Custom events for signals and Activity for surfaces |
| [0006](0006-slash-commands.md) | One command registry: pi's discovered commands plus reimplemented built-ins |
| [0007](0007-local-security.md) | Backend binds to loopback with a per-launch token |
| [0008](0008-design-system-lib.md) | A minimal design system library ships six stylesheets |
| [0009](0009-build-and-dev-tooling.md) | Nx build and dev tooling with pnpm and a hoisted node_modules |
| [0010](0010-durable-threads.md) | Durable threads: replay, SQLite layout, run locks and reconcile |
| [0011](0011-generative-ui-and-mcp.md) | Generative UI through CopilotKit's A2UI renderer and pi-kit's MCP Apps host |
| [0012](0012-panels-review-settings-and-trust.md) | Workspace panels, review mode and project trust |
| [0013](0013-packaging-crash-recovery-and-updates.md) | Packaging, release builds, crash recovery, pi update check and transcript performance |
| [0014](0014-files-decoration-and-graph-v2.md) | Files panel shows git status badges and refreshes live |
| [0015](0015-projects-and-thread-state.md) | Projects as sidebar groups and pushed thread state |
| [0016](0016-the-attendant-agent.md) | An optional attendant agent that tends the thread list |
| [0017](0017-voice-input-and-model-download.md) | Local voice input with Whistle and the compact composer toolbar |
| [0018](0018-connectors.md) | Connectors: one-click remote MCP servers through pi's own configuration |
| [0019](0019-secrets-at-rest.md) | Secrets at rest: credential store, encrypted database, redaction |
| [0020](0020-worktrees-and-coordination.md) | Worktree per thread, and coordination between agents in one folder |
| [0021](0021-copilotkit-components-first.md) | CopilotKit Angular components first, daisyUI theming, pi-kit slots |
| [0022](0022-latest-dependencies.md) | Latest dependency versions, pinned exactly, upgraded as a wave |
| [0023](0023-pi-updates-in-app.md) | pi updates from inside pi-kit through pi's managed install |
| [0024](0024-ngrx-signal-store.md) | Renderer state and logic live in NgRx SignalStores |
| [0025](0025-human-in-the-loop-and-the-queue.md) | Human-in-the-loop blocks, message toolbars and the queue bar |
| [0026](0026-domain-structure-and-boundaries.md) | The renderer is organised by domain with typed libraries and enforced boundaries |
| [0027](0027-api-contract-zod-swagger-typed-client.md) | One API contract: zod schemas, generated OpenAPI and SDK, overridable renderer policies |
| [0028](0028-learning-from-finished-threads.md) | Learning from finished threads: outcomes, distilled skills, verification |
| [0029](0029-browser-artifacts.md) | Browser artifacts shared with the agent |
| [0030](0030-guided-local-model-runtime.md) | Manage local models through the user's existing llama-swap config |
| [0031](0031-agent-authored-ui-and-standard-interrupts.md) | Agent-authored A2UI and Open Generative UI, with standard AG-UI interrupts |
| [0032](0032-thread-hydration-and-virtual-transcript.md) | Hydrate thread state, cache cursor replay and virtualize the transcript |
| [0033](0033-durable-background-agents.md) | Durable background agents per thread, on pi-durable, shown through AG-UI |
| [0034](0034-backend-domain-folders-four-roles.md) | Backend folders are one module per domain with four roles |
