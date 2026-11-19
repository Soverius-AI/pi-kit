# ADR-0038: Rooms send one goal's work to the owner's other machines

Status: Proposed
Date: 2026-11-19

## Context

A thread is one conversation with one pi session on one environment ([ADR-0003](0003-pi-sessions-are-the-source-of-truth.md), [ADR-0015](0015-projects-and-thread-state.md)). Background agents split work inside that thread on the same machine ([ADR-0033](0033-durable-background-agents.md)). Remote access lets the owner drive another paired instance, but it moves the person, not the work ([ADR-0035](0035-remote-access-over-the-tailnet.md)). Nothing lets the owner run a task on another machine, at an exact commit, and get a reviewable result back into the work that asked for it. The design is in `doc/designs/rooms-and-threads-ux-handoff.md`; the architecture research is in `doc/designs/cross-machine-collaboration-research.md`.

## Decision

- A **room** is a new domain beside threads, not a kind of thread. It holds a shared timeline, tasks and results for one goal. It never shares a pi session, session files or databases between machines; each agent keeps its own session on its own environment.
- v1 is **one owner and their paired environments**. Remote access has no per-person identity, so a room has no other people.
- A room has a **host**: the environment that runs the room coordinator and a **lead**, a new pi session seeded only with the summary the owner approved. The originating thread's session never becomes the lead.
- **Workers** run one approved task each, in an isolated worktree pinned to a base commit, on a paired environment that agreed to run tasks. Results come back as commits; integration merges them in a worktree on the host. Code moves through Git, never through synchronized folders.
- Agents know the roster through a `pikit-room` prompt section and talk through room tools. Workers and the lead form a hub: workers never wake each other. The **coordinator**, not the models, enforces a hop limit, a daily budget and Pause; every agent message is in the timeline. Approving tasks, running on another machine and integrating always need the owner.
- The renderer owns room state in a new `libs/rooms/` domain (api, data, feature-room, ui). Authorization, task ownership and the guardrails live in a backend collaboration domain. Room routes reach paired instances through the existing remote gateway and peer API, each marked deliberately.
- Rooms are behind **Rooms (preview)**, a runtime profile setting (`collaboration.rooms`, default off) with the backend as the authority. Off means room routes answer 404 and the renderer shows no room UI; threads look and behave as before.

## Consequences

- Threads, background agents and remote access keep their models; a room composes them.
- The thread list is untouched in structure. A Rooms / Threads switch appears in the sidebar while Rooms (preview) is on, beside the usual search field.
- Paired environments must each opt in to Rooms (preview) and to running tasks; a room never runs work somewhere silently.
- Several people, agent-to-agent traffic outside the hub, remote terminals and environment looks are out of scope until their own decisions.
- The transport is proposed in `doc/designs/rooms-transport.md`: the entry reaches the host through the existing instance proxy and keeps a room directory cache; host and workers exchange commands over signed peer sessions with an outbox, and results travel as Git bundles. Rooms (preview) gates room routes at runtime with a 404, because the remote allowlist is generated at build time.
