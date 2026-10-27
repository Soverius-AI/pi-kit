# ADR-0028: Learning from finished threads: outcomes, distilled skills, verification

Status: Accepted
Date: 2026-10-17

## Context

A thread that ends well leaves a commit (a worktree merged back; a commit in the folder; a pull request) and a
transcript that shows how the result was reached. pi-kit keeps the first in git and the second in pi's session file and
connects neither to the thread: the sidebar says "Finished", nothing says "and it was merged", and the know-how in the
transcript is reused only if the person remembers it. Hermes Agent writes a portable `SKILL.md` from its own trajectory.
pi has the pieces to do this without a new format: `SKILL.md` skills, pi packages, extension events, the attendant,
the worktree service, change baselines, skill chips, redaction.
pi-kit can add what Hermes cannot: a ground truth. A thread that ended in a commit has a base and a result, so a skill
distilled from it can be run again from the base and compared with what the thread produced.

## Decision

### §1 Outcomes: a thread knows how it ended

- `threads.base_commit` (with `base_source` `start | estimated | none`) is the folder's HEAD when a thread starts; older threads are estimated once from their first message's time.
- `thread_outcomes` holds one row per thread, `kind ∈ merged | committed | pr`: `merged` from the worktree merge-back (base is the merge's first parent), `pr` after `gh pr create` (base is the merge-base), `committed` from the folder watcher, which attributes a commit to the candidate thread whose change baselines overlap its files most; later commits extend the outcome. A verification replay never gets an outcome.
- An outcome badge on the sidebar row and the header crumb opens review mode on the "Outcome" source `base..head`, the third source of the Changes panel (read-only: no revert, no stage). The badge's menu is extensible (`OutcomeMenuStore.extend`). `GET /api/threads/:id/outcome` serves the record.

### §2 Learning: the attendant drafts, the person approves or discards

- With the attendant on, a thread that lands its first outcome and looks worth it (at least 6 tool calls, at least 10 changed lines, no listed skill matching the first prompt) is drafted without being asked, in the attendant's queue under its cap and per-project opt-out. Otherwise the person asks: the badge menu, the thread menu, `/learn [thread]`. With the attendant off, the person consents once per thread before the transcript goes to a model.
- The analysis sees a reduced transcript (prompts, tool calls, errors and their recovery, checks, the outcome diff, the commit message) after pi-kit's redaction pass, whatever the per-folder switch says.
- A draft is a `SKILL.md` in pi's format with provenance `x-pi-kit: { learnedFrom, base, head, verified }`, stored in `skill_drafts` (`pending | approved | discarded`, one per thread), never in `.pi/skills/`. Drafting and review open as a page in a persistent `Learn: …` chat under the project, with no modal; learning chats are excluded from drafting and from the attendant.
- Approve is the only writer of a skill folder (project `.pi/skills/<name>/` or the user's skills folder): the name must be a pi skill name not already listed, the text must parse with pi's own frontmatter parser, and idle sessions reload. Discard keeps the record so the thread is not drafted again; a discarded draft can be reopened. An approved draft outlives its thread.

### §3 Verification: the skill must reproduce its origin

- A replay creates a scratch worktree at the outcome's base commit, writes the draft as `.pi/skills/<name>/SKILL.md` there and nowhere else, and runs the thread's first prompt (editable) as an ordinary headless run with the skill pinned as a composer chip, on the model the thread used. It is visible in the sidebar and stoppable. Trust is granted only when the scratch worktree holds nothing a person has not already answered for.
- Both diffs are `git diff --no-renames -U0`; similarity is the Dice coefficient over changed lines. A file is reproduced at 0.8 or more. Pass: every file reproduced, whole-diff similarity 0.9 or more, no check that passed in the thread fails now. Failed: no file reproduced or similarity under 0.3. Partial: anything between. Every compared file is in the record.
- The thread's own checks are re-run in the scratch worktree with `CI=1`, except a command the redaction masked or one that names the original folder by absolute path. There are no deadlines: a replay runs to completion or Stop, which aborts the model run and the whole shell process group; shutdown waits for cleanup.
- The report is `skill_drafts.verification`. A `done` replay writes `x-pi-kit.verified` into the draft and into the approved file, only for exactly the replayed text (`skillHash`); an edit after the report makes it stale. The report informs the decision, it does not gate Approve.
- The replay thread is kept, archived, as the record; its worktree and branch are removed on every kind of end and it cannot run again. Nothing is pushed or merged. The scratch worktree is a working folder, not a sandbox: the main checkout's HEAD and status are compared before and after, and a difference is a warning in the report.

### §4 The loop: skills carry their record

- `skill_uses` records every prompt that carries a learned skill (a chip or a typed `/skill:`), keyed by the thread it was learned from; an outcome marks all of its thread's uses with its kind. A replay is never a use.
- `GET /api/skills/learned` gives each learned skill its provenance, last verification (stale when the file differs from the replayed text), uses, merged-after-use count, threads, last use and a flag: `no-outcomes` when the last three ended threads had no outcome, `failed-verification` when the last verification failed and none of the three merged.
- Settings › Skills shows the record under the skill row with Re-verify, Edit (the one writer's second function; provenance is stamped again), Retire (moves the folder to `skills/.retired/<name>/`; nothing is deleted) and Restore.
- Pruning or grading on a schedule is not built; the record and the flag are what such a loop would read.

### §5 A pi package, not core: `@pi-kit/learn`

- The analysis, the prompt, the skill template, `/learn [thread]` and `/learn verify` live in `packages/pi-kit-learn`, shipped beside the backend and installed into the bundled pi once (`pi remove` stays removed; `PI_KIT_LEARN_PACKAGE=off` skips it). The backend loads the installed package's analysis for the attendant's own drafts, so a removed package means no drafting.
- pi-kit's parts (the outcome store and badge, the review page, the worktree run) talk to the package through the plugin API: `pi-kit:<channel>` requests on pi's bus and `<channel>:reply` answers, documented in `docs/plugins.md`: `pi-kit:thread:transcript`, `pi-kit:thread:outcome`, `pi-kit:attendant:run`, `pi-kit:learn:draft`, `pi-kit:learn:verified`. The `pi-kit:*` extension events are the documented plugin API and this package is its first consumer.
- `/learn` in the pi command line needs pi-kit running: nothing else answers the events.

## Consequences

- The schema gains `threads.base_commit`, `thread_outcomes`, `skill_drafts` and `skill_uses`; the attendant's suggestion and action kinds gain `learn`.
- The attendant gets a third job, drafting; nothing reaches `.pi/skills/` without the person's approval.
- A verification costs a worktree, a model run and the project's checks; it is opt-in per draft and counted by the cap when it runs on the attendant's model. Replays of different drafts run independently, with no global limit.
- A passed verification is a record, not a guarantee; the record is kept and shown.
- Learned skills are ordinary pi skills: portable, editable, shareable as a package.
- Not seen: commits in a worktree before its merge-back, commits made while the backend is not running, skill uses from the pi command line.
