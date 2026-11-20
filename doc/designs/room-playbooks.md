# Room playbooks

A room playbook turns a room into a repeatable workflow without code in pi-kit: reviewing pull requests, refining a ticket with several roles, triaging issues. pi-kit ships the runtime; the workflow lives in the repository as a skill.

## A playbook is a skill

`<repository>/.pi/skills/<name>/` (or `.agents/skills/…`) holding a plain Agent Skill (`SKILL.md`: name, description, the lead's instructions) and `room.yaml` beside it. `SKILL.md` stays within the Agent Skills spec (agentskills.io), so the folder validates and works as a skill in any tool; `metadata: { pi-kit-room: room.yaml }` points at the room settings, and pi-kit treats any skill folder with a `room.yaml` as a playbook. Being a skill it is versioned with the code, reviewed like code, reaches every clone, and an agent can write it: pi-kit bundles the `pi-room-playbook` skill that teaches the format.

`room.yaml` borrows the vocabulary of GitHub Agentic Workflows where the meaning is the same: `on` for what wakes the lead, `tools` for what it may read with, `safe-outputs` for everything that writes, each a draft the owner approves.

```yaml
participants: [{ role, agent: { machine | agent }, instructions }]
tools: { name: { run: [argv…] | mcp: { server, tool, args } | mail: {…} | calendar: {…}, description } }
safe-outputs: { name: { <one of the same>, description, mode: draft|auto, max: <per day> } }
vars: { name: value }
on:
  schedule: [{ id, every | cron, say }]
  poll: [{ id, tool, every, with, key: [paths], say }]
stages: [names]
gates: { stage: owner|lead }
```

`GET /api/rooms/playbooks` lists playbooks (with parse errors), and `CreateRoom.playbook` starts a room with one; such rooms start Assisted at the first stage.

## What the runtime adds

| Lead tool | Does |
| --- | --- |
| `room_consult` | Asks one participant. Local: a sandboxed read-only thread per room and role, so it keeps context. Paired pi-kit: an A2A message with the room-task extension metadata `{consult: true, …}`; the peer runs the same consultant in its clone and returns an `answer` artifact. Outside agent: plain A2A text. |
| `room_discuss` | The same question to several roles at once; the lead weighs the answers. |
| `room_call` | Runs a tool or safe output by name: argv through `execFile`, no shell, in the room's project folder; local `mail` (Mail on macOS, through JXA) or `calendar` (EventKit on macOS, or an iCalendar URL or file anywhere); or an `mcp` tool of a server in the user's `mcp.json` (stdio, HTTP with a header, or HTTP with OAuth through pi's own credential store once the user signed in; values resolved the way pi resolves them; one connection per call). `{param}` is filled from params, `vars`, `{repository}`, `{room}`; argv values may not start with `-`. Output over 48 KB comes in pages (`page`), kept ten minutes so a later page does not run the command again. Tools run at once. Safe outputs become a draft unless `mode: auto`, and `max` caps calls per day. A name not in the playbook is refused. |
| `room_playbook_guide` | Returns the bundled `pi-room-playbook` skill, which a sandboxed lead cannot read from pi-kit's install folder. |
| `room_note` | Notebook in pi-kit's database (`room_memory`): scope `room:<id>` or `playbook:<repository>/<name>`, the latter carried to later rooms. Shown in the briefing and in the room. |
| `room_advance` | Moves to a stage; a stage gated `owner` becomes an approval. |

Drafts and gated stages are `room_actions` the owner approves or discards (`POST /api/rooms/:id/actions/:actionId`); the result goes back to the lead. Nothing outbound runs without that click unless the playbook's author set `auto`.

Triggers run on the 15 s tick while the room is not paused. `on.schedule` wakes the lead every interval or at matching cron minutes (local time). `on.poll` runs a tool when due (at least 30 s); its output must be JSON (an array of items); an item is new when its `key` was not seen (`room_trigger_seen`), so `[number, headRefOid]` re-triggers on a new push. New items (at most five per firing) wake the lead and reset its agent-turn counter.

Consultant answers are room events with actor `consultant`, a `role` and the machine that answered. Consultant threads stay out of the thread list, as lead and worker threads do.

## Trust

Tools and safe outputs run commands from the repository with the owner's tools and logins, and read the owner's mail and calendars on the machine pi-kit runs on. They run only in rooms the owner started with that playbook, the picker shows roles, tools and safe outputs, and every write is a safe output, a draft by default. The lead and consultants stay read-only; code still changes only through approved tasks.

## Not yet

Mail beyond macOS (IMAP), writing mail or calendar events, expanding repeating iCalendar events; MCP servers that sign in through a model provider; the project's own `.pi/mcp.json`; editing the notebook by hand, and per-trigger cursors beyond the seen-key set.
