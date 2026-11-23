# Room workspaces and linked folders

Status: design added 2026-11-23 during the [personal assistant and phone-channel research](rooms-phone-channels.md). Host-local read-only links, stable lead/consultant workspaces, safe owned files and sandbox enforcement are now implemented; see [implementation status](rooms-whatsapp-implementation.md). Writable references and remote folder synchronization remain outside this implementation.

## Intended experience

Every room has a stable working folder. The owner can attach existing folders through named symlinks, and agents can use those paths while staying based in the room. A personal assistant can combine notes, documents and a project without making one of them its permanent working directory.

Example layout:

```text
<dataDir>/rooms/<roomId>/
  playbooks/                         existing room playbooks
  workspace/                         lead and local consultants' cwd
    folders/
      notes -> /data/personal-notes
      project -> /data/projects/pi-kit
      documents -> /data/documents
    inbox/                           uploads and incoming attachments
    outputs/                         briefs, reports and generated files
```

The agent sees `folders/notes`, `folders/project` and `folders/documents` in its room briefing. It can read `folders/notes/today.md`, search the attached notes or run a repository-aware command such as `git -C folders/project status`. It does not have to change the room session's base directory to do those tasks.

The separate `workspace/` keeps the agent's writable working area distinct from app-managed playbook/configuration storage and the rest of the host's data directory. Memory remains managed through the room's memory model; generated files are not a replacement for the commitment ledger.

## Room UI

Add a **Folders** section beside the existing Files/playbook information:

- **Add folder:** choose a folder on the room's host and give it a short alias.
- Show the alias, owning environment, actual target, effective access and availability.
- Open/browse the linked folder, rename its alias, change access or remove the attachment.
- Show missing targets as **Unavailable**, with a repair/relink action. Keep the alias stable until the owner changes it.

Start with references attached as read-only. An explicit read/write attachment may be offered where the runtime can enforce it and the agent's role permits it. A read/write folder does not remove the existing read-only role of a lead or consultant.

Adding a new target belongs in the paired app's host-aware folder selection flow. A phone can choose already-approved host folders; a chat can refer to an existing alias. Do not interpret an arbitrary path sent over WhatsApp as a new filesystem grant.

## Working-directory behavior

The room workspace is the default cwd for its lead and local consultants, including future turns and restarts. Attaching or selecting a folder does not retarget that session. Tool execution can explicitly target a folder alias when a command requires project context.

Playbooks need an explicit working-folder selection for commands that currently assume the project cwd. Preserve that assumption for existing repository playbooks through their recorded project attachment during migration; new routines can choose the room workspace or a named linked folder. Separate project resource discovery and trust from the agent's cwd so moving the lead into the room does not accidentally stop finding its chosen playbook or implicitly load every linked project's resources.

Approved coding workers still need isolated worktrees. Give a worker its own task workspace under the room, with a `project` link to the approved worktree and the allowed reference links. It can stay based in that task workspace while changes are committed from the linked worktree. Do not give multiple workers writable links to the shared checkout. This worker layout needs its own implementation slice; simply moving the lead's cwd is not a worktree migration.

“Stay in the room” describes the stable agent workspace, not a ban on a command using an explicit working directory. Existing tool integrations should continue to work against the intended repository.

## Symlinks and effective access

A symlink provides a convenient path, not an access boundary. The runtime must grant the selected canonical target to the agent as well as creating the link. A read-only attachment must be enforced against the real target by the sandbox and applicable file/tool paths, not represented only by a label in the UI.

The application should record room ID, attachment ID, environment ID, alias, target path, canonical target, access mode and availability. Treat this record as authoritative and materialize only the corresponding symlinks. The room agent should not be able to retarget app-managed links to acquire more access.

Implementation constraints:

- Validate aliases as one filename component; reject traversal and collisions with existing room files or aliases.
- Resolve nested symlinks to the approved target. Detect unexpected target changes rather than silently following a replacement into another directory.
- Extend the runtime's approved filesystem roots deliberately. Existing credential and secret-file exclusions must also cover linked roots.
- Linking a folder for content does not automatically trust its executable `.pi`/`.agents` resources. Use the existing project trust decision when those resources are needed.
- Folder discovery and search must enumerate approved aliases and search their targets explicitly. Do not rely on every recursive tool following directory symlinks or enable unrestricted traversal of all links.
- On removal, unlink the attachment and revoke its grant. Never recursively delete the target. Coordinate grant changes with running turns so the next operation cannot retain a removed capability through an old sandbox.
- If confinement cannot enforce the selected mode on an operating system, show that limitation and leave the grant inactive rather than claiming read-only protection. Windows may require a supported junction/link implementation; validate its effective target and permissions too.

These constraints belong in the runtime. The normal owner flow should remain “add a folder, name it, choose access.”

## Across environments

Symlinks are local to the machine running the agent. A host path is not a remote filesystem mount, and serializing `/data/notes` does not make its contents available on a paired worker.

Keep the same logical alias where possible, but resolve its target on each environment. A paired worker must have an explicitly approved equivalent folder or report the attachment unavailable. Git-backed project tasks can resolve their project attachment to the task's local worktree; arbitrary personal folders require an explicit local mapping. File transfer or synchronization is a separate capability, not an automatic consequence of linking.

Show the target environment in the room's Folders section. If an attached disk is offline or a worker has no mapping, the agent should report that state rather than assume an empty folder or create a new target.

## Current code and necessary changes

| Area | Current implementation | Required change |
| --- | --- | --- |
| Room-owned directory | `apps/backend/src/rooms/room-folders.ts` creates `<dataDir>/rooms/<id>/playbooks`. | Add a stable workspace with owned inbox/output directories and managed links. |
| Lead cwd | `room-lead.service.ts` uses `RoomAgents.projectFolder` when creating and running the lead. | Separate room workspace from project identity and resource discovery. |
| Consultant cwd | `room-consultant.service.ts` creates/runs the consultant in the supplied project folder. | Run from the room workspace with its permitted attachment manifest. |
| Playbook calls | `room-playbook.service.ts` executes tools against the project folder. | Resolve an explicit working-folder alias and retain existing playbook semantics. |
| Worker execution | `room-worker-runner.ts` runs and commits in the isolated worktree. | Introduce task workspaces only while retaining isolated worktree ownership and collection. |
| Sandbox | `packages/pi-sandbox/lib/core.ts` has a single `cwd`; `policy.ts` grants the cwd/temp/runtime and `worker-fs.ts` relies on OS enforcement. | Model approved read/write attachment roots and preserve protected paths across them. |
| Runtime protection | `apps/backend/src/pi/thread-protection.service.ts` protects the app data directory. | Grant only the room/task workspace and approved targets, retaining isolation from the database and other rooms. |
| UI/data model | Room detail has one project folder and one room folder. | Add attachment records, environment resolution, status and folder-management operations. |

## First slice and acceptance

Start with a host-local room workspace, owned uploads/outputs and two read-only linked folders for the lead and local consultants. Make attachment access work in the sandbox before expanding to writable targets or paired workers.

Verify that:

1. A room without Git can attach a notes folder and a project, and the agent uses both aliases while its cwd remains the workspace.
2. Links and alias metadata survive a host restart; a changed target is detected.
3. Search can find a known file inside each attachment without changing cwd.
4. Read-only attachments can be read but cannot be changed through either a file tool or a shell command, including through nested links.
5. Removing an attachment removes the link/grant and leaves target contents intact; another room's folder remains inaccessible.
6. An uploaded phone attachment is stored in the room's inbox and a generated brief in outputs, with useful links in the room timeline.
7. Existing project playbooks retain their intended command context. Workers still return changes from their approved worktrees.
8. An offline target or missing peer mapping is shown accurately in the UI and to the agent.
