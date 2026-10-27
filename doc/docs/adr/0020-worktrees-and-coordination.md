# ADR-0020: Worktree per thread, and coordination between agents in one folder

Status: Accepted
Date: 2026-10-16

## Context

pi does not know git worktrees: it has a `cwd` per session and nothing else. Two problems follow for a desktop app that
runs several threads at once: two threads editing the same checkout step on each other, and even inside one folder pi
has no idea that another agent is working next to it and will rewrite a file the other thread is editing. pi offers
the hooks to fix the second point from the outside: a `before_agent_start` handler may add system-prompt sections, a
`custom_message` can be put in front of the model at a turn boundary, and pi-kit already records which files each
thread touches (`change_baselines`) and each thread's state.

## Decision

- A worktree per thread is opt-in. The new thread's page offers Local or Worktree; the worktree is made at the first
  message and named after it (`/worktree new` makes one at once): `git worktree add <root>/<repo-slug>/<slug>
  -b <prefix><slug> <base>`. The root defaults to `~/.pi-kit/worktrees` (`PI_KIT_WORKTREE_ROOT` or the project's
  setting); the base is the request's, else the project's, else the checked-out branch, and may be `origin/<branch>`.
  A worktree may be detached (`branch: null`) or carry the folder's uncommitted changes as a binary patch (ask, always, never).
- The pi session's `cwd` is the worktree; `threads` keeps `project_cwd`, `worktree_path`, `branch` and `base_branch`,
  so the thread stays under its project with a badge and the branch in the crumbs, and a CLI session started in the
  worktree folder is adopted into the same thread. Trust is inherited from the project while the trust digest
  (extensions, skills, prompts, `mcp.json`, settings) of both folders is the same; otherwise the worktree asks itself.
- Setup scripts are a list per project (`id`, `name`, `command`, `copy` files), the first the default, derived from the
  lockfile when none is saved; the command is typed into the new folder's terminal and not watched.
- Thread actions: Sync with base (merge or rebase; conflicts stay in the worktree and show in review mode; Abort);
  Merge back (commit with a proposed message, `git merge --no-ff` into the base or `gh pr create`; a conflicting merge
  is undone in the main checkout; the folder goes by the project's "Remove the folder" rule; the outcome is recorded in `thread_outcomes`);
  Create branch here for a detached worktree; Hand off to local or to a worktree, moving the branch and the
  uncommitted changes. Archive and delete ask Keep or Remove; a dirty worktree needs `force`; a worktree another thread runs in stays.
- Coordination is an inline pi-kit extension bound to every session: on `before_agent_start` it sets the `other_agents`
  system-prompt section listing other threads of the project in the same folder or a worktree of the repository (title,
  state, branch, files edited in the last 30 minutes) with three rules, absent when the thread is alone; it returns a
  `custom_message` notice when a file this thread read or edited was changed by another thread since, never twice for
  the same change; and it gives pi's bash tool `PI_KIT=1` and `PI_KIT_THREAD_ID`. No hard locks, no cross-machine work.
- File leases are soft: `file_leases(thread_id, cwd, path, since, at)` are taken in `PiSessionService.onToolStart`, the
  same capture point as change baselines, and expire 30 minutes after the last edit. They feed the section, the Files
  panel's "being edited by" chip and review mode through `GET /api/threads/:id/coordination`. pi sessions from a
  terminal in the same folder are listed as "pi in a terminal".

## Consequences

- Worktrees cost disk and a setup run per thread; the default stays Local.
- The coordination section adds a few hundred tokens only when several threads are active in one place.
- A model can still edit a leased file; the lease is information plus a visible chip.
- What a thread read is kept in memory per backend run, so no notice follows a restart until the file is touched again.
- The attendant's "about to collide" pause suggestion is not built; the chip, the notice and the section carry it.
- A setup command that fails or takes minutes shows only in the terminal; nothing else tells the thread.
