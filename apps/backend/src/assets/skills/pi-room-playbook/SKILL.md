---
name: pi-room-playbook
description: Write or change a pi-kit room playbook, a skill that tells a room's lead how to run a recurring workflow (review pull requests, refine a ticket with several roles, triage mail, a morning brief from mail and calendar). Use when the user asks for a playbook, a room workflow, a personal assistant routine, or to automate what a room does.
---

# Room playbooks

A playbook is an ordinary Agent Skill with a `room.yaml` next to its `SKILL.md`. `SKILL.md` stays a plain skill (name, description, the lead's instructions as its body); `room.yaml` says who the lead can consult, which tools it reads with, which safe outputs it may write with, what wakes it, and the stages it moves through. The keys follow GitHub Agentic Workflows where they mean the same: `on`, `tools`, `safe-outputs`.

Put it in the project, so every clone and every teammate gets it:

```
<repository>/.pi/skills/<name>/SKILL.md
<repository>/.pi/skills/<name>/room.yaml
<repository>/.pi/skills/<name>/scripts/…     # optional helpers the tools run
```

(`.agents/skills/<name>/` works too.) The folder name and `name:` match, in kebab-case.

## SKILL.md

```markdown
---
name: pr-review
description: Review open pull requests with a security and a test reviewer; draft one review per PR.
metadata:
  pi-kit-room: room.yaml
---

How the lead works, step by step, in plain words: what to read, whom to consult, what to decide, which note to keep, which draft to leave for the owner.
```

## room.yaml

```yaml
participants: # whom the lead consults (room_consult, room_discuss)
  - role: security # kebab-case
    agent: { machine: Build box } # a paired pi-kit by name; leave out for this computer
    instructions: Look for injection, secrets and unsafe defaults.
  - role: outside
    agent: { agent: Review bot } # an outside A2A agent added in Settings

tools: # read only; they run when the lead calls them (room_call)
  open_prs:
    run: [gh, pr, list, --json, 'number,title,headRefOid,url'] # argv, never a shell
    description: Open pull requests as JSON.
  pr_diff:
    run: [gh, pr, diff, '{pr}']
  ticket:
    mcp: { server: linear, tool: get_issue, args: { id: '{ticket}' } } # a server in the user's mcp.json
  inbox:
    mail: { mailbox: inbox, unread: true, limit: 20 } # Mail on this Mac
  agenda:
    calendar: { days: 1 } # this Mac's calendars; or { ics: "${WORK_CALENDAR_URL}", days: 7 }

safe-outputs: # everything that writes; a draft the owner approves unless mode: auto
  post_review:
    run: [gh, pr, review, '{pr}', --comment, --body, '{body}']
    max: 10 # at most this many a day
    description: Post a review comment.

vars: {} # fixed values for {placeholders}

on:
  schedule: # wake the lead
    - id: brief
      cron: '0 8 * * 1-5' # five fields, this computer's time zone; or every: 30m
      say: Write the morning brief.
  poll: # run a tool and wake the lead for items it has not seen
    - id: new-prs
      tool: open_prs # a tool, never a safe output; it must print JSON (an array of items)
      every: 10m # s, m, h or d; at least 30s
      key: [number, headRefOid] # an item is new when this key was not seen; a new push re-triggers
      say: Review each new pull request.

stages: [review, verdict]
gates:
  verdict: owner # the owner approves moving into this stage
```

## Rules the runtime enforces

- A name is either a tool or a safe output. Tools only read and run at once. Anything that posts, sends, pushes or deletes is a safe output; set `mode: auto` only when the user asks for it.
- Each tool or safe output has exactly one of `run`, `mcp`, `mail` or `calendar`.
- `{name}` in `run`, in the string values of `mcp.args` and in `calendar.ics` is filled from the lead's params, then `vars`, then `{repository}` and `{room}`. A value in `run` may not start with `-`. `${NAME}` in `calendar.ics` and in `mcp.json` comes from the environment, so secret URLs stay out of the repository.
- `run` commands run in the room's project folder with the user's own tools and logins. There is no shell: write a script in the skill's `scripts/` folder and call it instead of pipes or `&&`.
- `mcp` names a server of the user's `~/.pi/agent/mcp.json`, usually one added under Settings, Connectors (Gmail, Google Calendar, Outlook, Linear and others). A server that signs in with OAuth works once the user has signed in there; one that signs in through a model provider does not.
- `mail` reads Mail on the Mac pi-kit runs on (newest first, with sender, subject, date and a short preview); `calendar` reads that Mac's calendars or an iCalendar URL or file. macOS asks the user once to allow it. Repeating events in an iCalendar file appear only on their first date.
- A long output reaches the lead a page at a time; `room_call` with `page` reads the next one.
- Triggers only use tools. A paused room fires nothing.
- The lead stays read-only. Code changes go through `room_propose_task`, which a worker runs in its own worktree after the owner approves; playbook files go through `room_playbook_propose`.
- Notes (`room_note`) live in pi-kit's database: scope `room` for this room, `playbook` for every later room of this playbook in this repository.

## Writing one with the user

1. Ask what should start the work (a ticket, a schedule, new pull requests, new mail), who should weigh in, what the result is, and what must never happen without them.
2. Find the commands, MCP tools or local sources that read and write the systems involved and try the reading ones.
3. Write both files, keep the body short and concrete, and put every write under `safe-outputs` as a draft.
4. In a read-only room thread, read this guide with `room_playbook_guide` instead of the file, and hand over both whole files with `room_playbook_propose` (also to change the room's own playbook). pi-kit checks them as it loads a playbook and gives the errors back; a valid proposal shows the owner its diff, and they apply it into the project folder.
5. Elsewhere, tell the user to start a room with the playbook from the room dialog; it appears there once the folder is committed or present in the clone.
6. To test a playbook, the owner can try each tool and fire triggers from the room's playbook panel, and rehearse: then safe outputs only pretend to run.
