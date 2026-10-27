# ADR-0001: Embed pi through its SDK as the agent engine

Status: Accepted
Date: 2026-10-15

## Context

pi (`@earendil-works/pi-coding-agent`) is the coding agent the desktop UI drives. It can be
driven three ways: the interactive TUI, `--mode rpc` (JSONL over stdio of a child process) and
the TypeScript SDK (`createAgentSession()`, `session.prompt()`, `subscribe()`, `steer()`,
`followUp()`, `abort()`, `SessionManager`). RPC mode gives crash isolation and language
independence, neither of which a Node backend needs. The SDK gives typed access to the session
tree, resource loading (skills, prompt templates, extensions, MCP), model switching, compaction
and tree navigation, which the RPC surface does not expose completely.

## Decision

- The NestJS backend embeds pi through the SDK, one `AgentSession` per open thread, created with
  `createAgentSession({ cwd, sessionManager, resourceLoader })`.
- MCP, codemode and tool search are added through `DefaultResourceLoader.extensionFactories`, so
  the UI sees the same tool set as the CLI.
- All pi access goes through one Nest service, `PiSessionService`. Nothing else imports the pi
  package.
- `rpc-entry` stays available as a fallback for running an agent in a sandboxed subprocess.

## Consequences

- A pi crash takes the backend down. Electron restarts the backend process; threads survive
  because pi persists sessions on every entry.
- pi major-version upgrades are absorbed in one service.
- The CLI's built-in slash commands are TUI-only and are reimplemented on SDK methods.
