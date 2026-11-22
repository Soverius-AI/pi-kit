# Room playbooks

A room playbook turns a room into a repeatable workflow without code in pi-kit: reviewing pull requests, refining a ticket with several roles, triaging issues. pi-kit ships the runtime; the workflow lives in the repository as a skill.

## A playbook is a skill

`<repository>/.pi/skills/<name>/` (or `.agents/skills/…`) holding a plain Agent Skill (`SKILL.md`: name, description, the lead's instructions) and `room.yaml` beside it. `SKILL.md` stays within the Agent Skills spec (agentskills.io), so the folder validates and works as a skill in any tool; `metadata: { pi-kit-room: room.yaml }` points at the room settings, and pi-kit treats any skill folder with a `room.yaml` as a playbook. Being a skill it is versioned with the code, reviewed like code, reaches every clone, and an agent can write it: pi-kit bundles the `pi-room-playbook` skill that teaches the format.

`room.yaml` borrows the vocabulary of GitHub Agentic Workflows where the meaning is the same: `on` for what wakes the lead, `tools` for what it may read with, `safe-outputs` for everything that writes, each a draft the owner approves.

```yaml
lead: { model, thinking }
workers: { model, thinking }
participants: [{ role, agent: { machine | agent }, instructions, model, thinking }]
tools: { name: { run: [argv…] | mcp: { server, tool, args } | mail: {…} | calendar: {…}, description } }
safe-outputs: { name: { <one of the same>, description, mode: draft|auto, max: <per day> } }
vars: { name: value }
on:
  schedule: [{ id, every | cron, say }]
  poll: [{ id, tool, every, with, key: [paths], say }]
stages: [names]
gates: { stage: owner|lead }
```

A playbook written for one room lives in that room's own folder instead: `<dataDir>/rooms/<roomId>/playbooks/<name>/`, with the same two files. Every room gets this folder when it starts. A playbook the lead proposes that does not exist yet is written there, so it stays out of the repository; a playbook of the project is changed where it is. The room's folder is looked at first, then the project's skill folders, and archiving a room keeps its folder.

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

## Models and thinking effort

Without settings every participant runs on the host's default model and thinking effort; the owner can change the lead's with the picker in the room's composer, which shows the effort for models that think. A playbook can set both: `lead` and `workers` at the top, and `model` and `thinking` on a participant. `model` is `provider/id`; `thinking` is one of pi's levels. The lead's are applied when the playbook is first briefed and again when it changes, so a later choice in the picker holds until then; a consultant's and a worker's when their thread starts a turn. A model that is not available leaves the thread on the default and shows as an error in the playbook's checks; an effort on a model that does not think is a warning. The settings apply to threads on the room's host: a participant or worker on another instance, and an outside agent, keep their own.

## Runs

Every turn of the lead is a run (`room_runs`): what woke it (the owner, a schedule, a poll, an approval, a stage change or an agent), the stage it started in, how it ended and the lead's answer. While it runs, each `room_call`, `room_consult` and `room_advance` is a step (`room_run_steps`) with its state, the call or question, the output and when it started and ended. A drafted safe output or a gated stage is a step that waits; it settles when the owner approves or discards the action, also after the run ended. `GET /api/rooms/:id/runs` lists the last fifty, and the room's stream sends a `run` line on every change. Runs left open by a restart are marked stopped.

The room shows them the way a CI service shows workflow runs: the playbook's overview is a graph from what wakes the lead, through the lead, to the stages with their state, and the Runs tab lists each run with its steps as a log that opens to the output.

## Live text

What the lead, a consultant or a worker writes reaches the room while it is written. Their turns all run through `AguiService.runHeadless`, which now hands every event of the run to an observer; `RoomLive` turns the text and tool events into `live` lines of the room's stream, a few times a second: the text to append (or the whole text after a reset), the tool being called, and an end. A piece that would show a secret is sent as the whole redacted text instead. A client that connects in the middle gets what each participant has written so far. The final text still arrives as the room event or the task's report; the live text is never stored.

A worker or consultant on a paired instance streams over A2A itself. While it runs, its pi-kit publishes what it writes as chunks of an artifact named `live` on the task (`append` for more text, a first chunk without it after a reset, `lastChunk` at the end, and the tool in use in the artifact's room-extension metadata), four times a second. The host subscribes to the task (`SubscribeToTask`, Server-Sent Events through the peer connection) and relays the chunks into the room's stream; after a question was answered it subscribes again. The chunks never enter the push outbox, which carries status only, and the `live` artifact is left out of the stored task and of the result. An outside A2A agent that streams its task gets the same treatment: text chunks of its artifacts show as live text while the task runs. An outside agent asked as a consultant still answers in one piece, because that call waits for the whole answer.

## Without a window

Rooms and playbooks run in the backend, so they work on a server with no desktop app and no browser: the triggers tick, the lead and the consultants run, and runs are recorded. `pi-kit rooms` does there what the room view does: turn rooms on, start a room from a folder with a playbook, show what waits, approve or discard drafts, stages, playbook changes and tasks, answer questions, fire a trigger, read the runs with their steps, and follow a room live (see [Server and CLI](../docs/server.md)). `POST /api/rooms` takes a `projectFolder` alone for this: a git repository on the host, which becomes a project.

What still needs a person at a screen: signing an MCP server in with OAuth the first time, and the local mail and calendar sources, which use the Mac's own apps and permissions.

## Trust

Tools and safe outputs run commands from the repository with the owner's tools and logins, and read the owner's mail and calendars on the machine pi-kit runs on. They run only in rooms the owner started with that playbook, the picker shows roles, tools and safe outputs, and every write is a safe output, a draft by default. The lead and consultants stay read-only; code still changes only through approved tasks.

## Not yet

Mail beyond macOS (IMAP), writing mail or calendar events, expanding repeating iCalendar events; MCP servers that sign in through a model provider; the project's own `.pi/mcp.json`; editing the notebook by hand, and per-trigger cursors beyond the seen-key set.
