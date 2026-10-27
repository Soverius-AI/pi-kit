# Plugins

A pi-kit plugin is a **pi package** that talks to pi-kit through events on pi's shared bus. There is no second extension system: the package is a normal pi package (`pi install`, `pi list`, `pi remove`, `pi config`), its extension is a normal pi extension, and the events are how it asks pi-kit for what only pi-kit has: a thread's transcript and outcome, a model call under the attendant's cost cap, a place to hand a result back. The first plugin is [`@pi-kit/learn`](https://github.com/wolfmanfx/pi-kit/tree/main/packages/pi-kit-learn) ([ADR-0028](adr/0028-learning-from-finished-threads.md)); the second is `@pi-kit/meat-proxy`. This page is the contract; the schemas are in [`libs/shared/protocol/src/plugins.ts`](https://github.com/wolfmanfx/pi-kit/blob/main/libs/shared/protocol/src/plugins.ts) and every request is validated against them.

Status: built for `@pi-kit/learn` (with `pi-kit:learn:verified`) and extended for `@pi-kit/meat-proxy` (`thread:baselines`, `thread:outside-edits`, `thread:annotate`, the transcript `turns`, the `score` task). Nothing is reserved any more.

## The shape of a call

An extension reaches the bus as `pi.events`. A request is one `emit`; the answer is an `emit` of pi-kit's on the channel's `:reply`:

```ts
pi.events.emit('pi-kit:thread:transcript', { requestId, thread? })

pi.events.on('pi-kit:thread:transcript:reply', (reply) => {
  // { requestId, ok: true, ...result }   or   { requestId, ok: false, code, error, model? }
})
```

- `requestId` is the caller's own string; the reply carries it back, so several requests can be in flight.
- `thread` is a thread id, or the start of one when it is unique. Left out, it is the thread the extension is running in.
- A failure has a `code` for the caller's decision and an `error` sentence for the person: `invalid` (the request does not fit its schema), `not-found`, `consent`, `off`, `cap`, `no-model`, `conflict`, `failed`.
- Only pi-kit answers, and it says so first: pi's bus is synchronous, and pi-kit emits `<channel>:accepted` with `{ requestId }` **inside the request's `emit`**, before it works on the request. Subscribe to `<channel>:accepted` and `<channel>:reply` before emitting; when the `emit` returns and nothing was accepted, nobody is listening (the pi command line, or pi-kit without that host) and the command says that pi-kit is needed, at once. No clock decides that, and the reply has no deadline: a slow model is given its time. [`ask()` in `extensions/meat-proxy.ts`](https://github.com/wolfmanfx/pi-kit/tree/main/packages/pi-kit-meat-proxy/extensions/meat-proxy.ts) is the worked example; copy it.
- A request belongs to the session it was emitted in. When that session closes (the thread is closed, the backend quits, the session is opened again) while a request is open, pi-kit aborts what it started for it (a model call) and answers `{ requestId, ok: false, code: 'failed', error: 'The session closed before pi-kit answered.' }` on the session's `<channel>:reply`; nothing of the old session reaches the next one.
- Pressing Stop aborts the session's open requests and answers `{ requestId, ok: false, code: 'failed', error: 'The request was cancelled before pi-kit answered.' }`. The session stays open and accepts fresh requests. A verification replay has its own thread and Stop; ending the original request's wait does not end that independent job.
- A request that has no `requestId` is not answered (there is nobody to answer to).

## The events

### `pi-kit:composer` (one way, [ADR-0014](adr/0014-files-decoration-and-graph-v2.md))

Toolbar buttons and suggestion pills for the composer. `pi.events.emit('pi-kit:composer', { op: 'action' | 'suggestion' | 'remove', id, ... })`; pi-kit validates it with `ComposerRegistrationSchema` and shows it. No reply. `@pi-kit/computer-use` uses only this event, for the pill that offers to set up its macOS permissions.

### `pi-kit:thread:transcript`

The thread reduced for analysis, **after the redaction pass** ([ADR-0019](adr/0019-secrets-at-rest.md): known key shapes and the user's own patterns are masked; the per-folder "pass off" switch does not apply to text that goes to a model).

- Request: `{ requestId, thread? }`.
- Reply: `{ ok: true, transcript, draft }`. `transcript` is `ThreadTranscript`:

| Field | What |
|---|---|
| `threadId`, `title`, `cwd` | the thread and its project folder |
| `prompts` | what the person asked, in order, at most 12, each at most 1500 characters |
| `toolCalls` | how many tool calls the thread made |
| `steps` | `{ n, tool, target, outcome }` per call, `target` being the file, command, pattern or address; more than 200 and the middle is cut (`truncated`) |
| `errors` | `{ step, tool, target, message, recovered, recoveredBy }`: a failed call, and the later call of the same tool and target that worked |
| `checks` | `{ step, command, passed }`: shell commands that check the work (`npm test`, `vitest`, `pytest`, `tsc`, a build, a linter) |
| `diff`, `changedLines`, `commitMessage`, `base`, `head` | the outcome's `git diff base..head` (cut at 14,000 characters), its size, the head commit's message; null / 0 without an outcome |
| `truncated`, `redactions` | something was cut to fit; how many places were masked |

`draft` is the thread's skill draft (`{ id, name, state }`) or `null`, so a package can stop before it spends a model call on a thread that has one.

**`turns`.** The same messages as `prompts`, with what came of each, for a package that measures the person's part. One entry per user message, in order:

| Field | What |
|---|---|
| `n`, `at`, `text` | the 1-based number, when it was sent (epoch ms, or null) and the text as typed (a message with skill chips shows the sentence, not the expanded instructions) |
| `queued` | pi took the message from its queue the moment the turn before ended (a follow-up or a steer within 2 s of the previous entry): nobody waited for it |
| `gapMs` | milliseconds between the previous entry of the session and this message: the person's time between turns; null for the first |
| `toolCalls`, `files` | how many tool calls followed it, and the files pi edited or wrote while working on it (relative to the project, at most 40) |
| `chips` | the skill and prompt-template chips it carried |
| `review` | the review comments that travelled with it (`file`, `side`, `line`, `endLine`, `text`, `snippet`; [ADR-0012](adr/0012-panels-review-settings-and-trust.md)), or null |
| `answers` | the dialogs the person answered while pi worked on it (`method`, `title`, `status`, `confirmed` or `value`; [ADR-0025](adr/0025-human-in-the-loop-and-the-queue.md)). pi keeps no record of these, so pi-kit does (`thread_dialog_answers`) |
| `previous` | the end of what pi said before the message (at most 400 characters), for rules like "quoting pi's own words" |

Everything in a turn goes through the redaction pass like the rest of the transcript.

### `pi-kit:thread:outcome`

How the thread ended ([ADR-0028](adr/0028-learning-from-finished-threads.md) §1): `merged`, `committed` or `pr`.

- Request: `{ requestId, thread?, diff? }`; `diff: true` adds the unified diff.
- Reply: `{ ok: true, outcome, diff? }`. `outcome` is `ThreadOutcome` (`kind`, `base`, `head`, `merge`, `prUrl`, `at`, `files`, `baseBranch`, `baseSource`) or `null`.
- `annotations: true`  adds `annotations: { hunkLabels, scores }`: what plugins stored with the outcome through `pi-kit:thread:annotate`, including the person's corrections of the labels (`hunkLabels.corrections`), so a package can show them to its model as examples. Both are `null` for a thread nobody scored.
- The diff is `git diff --no-renames --relative -U3 base..head` in the project's folder: paths relative to the folder, the same hunks the Outcome view shows. **Hunk ids** (below) are derived from it.

### `pi-kit:attendant:run`

One model call through the attendant: its model (Settings › Attendant), its daily cost cap, its activity list. The package writes the prompt; pi-kit sends it, prices it and lists it.

- Request: `{ requestId, thread?, task: 'learn' | 'score', system, user, consent? }`. The task names the activity kind the call is listed under and picks the consent sentence ("…to draft a skill" or "…to attribute each change to what you did"); the agreement is kept per thread and per task.
- Reply: `{ ok: true, text, model, inputTokens, outputTokens, cost }`.
- With the attendant **off**, the first call for a thread answers `{ ok: false, code: 'consent', error, model }`: `error` is the sentence to show ("This sends the thread's transcript … to *model* …") and `model` the model's name. The package asks the person (`ctx.ui.confirm`) and sends the request again with `consent: true`; pi-kit remembers the answer for that thread. With the attendant on there is no question: the person switched it on.
- Other failures: `cap` (the day's cap is reached), `no-model`, `failed` (the request itself).

### `pi-kit:learn:draft`

Hands a draft skill back. pi-kit validates it, adds the provenance (`x-pi-kit`: the thread, the outcome's base and head commits, `verified: null`), and keeps it as **pending** in its database, with a card at the end of the thread and a chip on the sidebar row. **It never writes a skills folder**: only the person's Approve does.

- Request: `{ requestId, thread?, text, model? }`; `text` is a `SKILL.md`.
- Reply: `{ ok: true, draft }` (`SkillDraft`), or `invalid` (not a skill pi would load), `conflict` (the thread has a draft already: one per thread).

### `pi-kit:thread:baselines`

The files pi edited or wrote in the thread (the change baselines of [ADR-0012](adr/0012-panels-review-settings-and-trust.md)), never their content (which may be large or private).

- Request: `{ requestId, thread? }`.
- Reply: `{ ok: true, files }`, each `{ path, existed, at, turn, edits }`: relative to the project; `existed` false when pi created the file; `at` when pi first touched it (epoch ms); `turn` the 1-based message in which it did, or null; `edits` how many `edit` and `write` calls touched it.

### `pi-kit:thread:outside-edits`

The files of the thread's folder that changed while no run of pi was writing there, as the folder watcher ([ADR-0014](adr/0014-files-decoration-and-graph-v2.md)) saw them: changes by hand. pi-kit keeps the record itself (`thread_outside_edits`; there was none before): while a thread runs, pi-kit holds its folder (the thread's worktree, or the project) and for two hours after the last run; a watcher batch is noted for the threads of that folder that ran lately unless a run is going on in the folder, a run ended in the last 2.5 s (the batch is debounced), or the batch moves `HEAD` (a checkout, a pull, a merge: git changed the files). `.git` is never a hand. What it cannot see: an edit made while pi was running in the same folder, and a change made while pi-kit was not running.

- Request: `{ requestId, thread? }`.
- Reply: `{ ok: true, edits }`, each `{ path, firstAt, lastAt, count }` (`count` is the number of watcher batches that reported the file; at most 500 files per thread).

### `pi-kit:thread:annotate`

Hands labels and scores back. pi-kit stores them with the thread's outcome (`thread_outcomes.hunk_labels` and `scores`, which `put` never touches), and **draws them while the package is installed** (see "Removable without a trace"): the badge's second line and menu, the Outcome view's meter and hunk labels, the project histogram in Settings.

- Request: `{ requestId, thread?, base, head, model?, labels?, scores? }`. `base` and `head` are the outcome the labels describe; when it moves on (a later commit) pi-kit says the labels are out of date. `labels` is a list of `HunkLabelEntry` (`id`, `file`, `header`, `label`, `input`, `turn?`, `trace`, `lines`, `excerpt?`, `by`, `was?`); `scores` is `OutcomeScores` (`meat`, `vibe`, `hunks`, `steered`, `lines`, `steeredLines`, `byLabel`, `byInput`, `line`). Left out leaves the stored value, `null` clears it.
- New `labels` replace the package's earlier ones; **the person's corrections of them stay** (a relabelled hunk in the Outcome view is kept per hunk id and shown to the model as an example the next time), and when there are any, pi-kit computes the score again over the labels as they stand with the package's own arithmetic.
- Reply: `{ ok: true }`, or `not-found` (the thread has no outcome), `invalid`.

**Hunk ids.** A hunk is named by its file and the two start lines of its `@@` header exactly as git prints them: `src/a.ts@10:12` (`@@ -10,6 +12,8 @@`; a new file is `x@0:1`). The package derives them from the diff, the Outcome view from its diff model; both read the same `git diff`, so a stored label finds its hunk on screen.


### `pi-kit:learn:verified`

Replays the thread's draft skill from the commit the thread started at and answers with the report ([ADR-0028](adr/0028-learning-from-finished-threads.md) §3). pi-kit makes a scratch worktree at the outcome's base commit (under the worktree root, never the main checkout), starts a thread there titled "Verify: *name*" (visible in the sidebar, stoppable) with the draft pinned as a skill chip and the thread's first prompt, lets it run to the end, compares what it did with the outcome's `git diff base..head` (files and hunks, a similarity score), runs the thread's checks again, and removes the worktree. The reply comes **when that is over**, which takes a minute to many: the caller waits for it with no deadline (there is no clock on a replay; the person stops it from the thread), and a session that closes first gets the closed answer while the replay runs on under pi-kit's own verification job.

- Request: `{ requestId, thread?, start?, prompt? }`. `start: false` only reads the last report without starting a replay. `prompt` replaces the thread's first prompt for this run.
- Reply: `{ ok: true, draft: { id, name, state }, verification }`. `verification` is `SkillVerification`: `state` (`done`, `stopped`, `error`, or `running` for a read), and for `done` the `result` (`pass` | `partial` | `failed`), the `score` of the whole diff (0 to 1), `files` (`{ reproduced, expected, extra }`), `hunks` (`{ matched, expected, actual }`), `fileList` (path, status `same | similar | different | missing | extra`, similarity, hunks), `checks` (the command, whether it passed in the thread, whether it passed again, the exit code, the last lines of its output), `summary` (one sentence with the numbers), `warnings`, the replayed `prompt`, `model`, the verification `threadId` and `base` / `head`. `error` is a replay that could not be carried out (the project is not trusted, no worktree could be made, the model failed, pi stopped to ask a question): it says nothing about the skill.
- Failures: `not-found` (no thread, or the thread has no draft: run `/learn` first), `conflict` (no outcome to replay from, a discarded draft, or that draft is being verified already; replays of different drafts run side by side), `invalid`, `off`, `failed`.
- **What counts.** A file is *reproduced* when the lines it added and removed are at least 80 % the same as the outcome's (Dice coefficient over the changed lines, trailing blanks ignored); a hunk is matched one to one the same way. `pass`: every file reproduced, the whole diff at least 90 % alike, and no check that passed in the thread fails now. `failed`: no file reproduced, or the whole diff under 30 % alike. Anything between is `partial`. The same words are in the review dialog and, as `x-pi-kit.verified` (`result`, `at`, `files`, `hunks`, `checks`, `similarity`, `replayedFrom`), in the draft's frontmatter and in the `SKILL.md` Approve writes, only for a replay of exactly that text.
- **Safe by construction.** The replay's session works in the scratch worktree, not in the project; it is a normal pi session, so nothing stops a tool from writing elsewhere by absolute path, and pi-kit looks at the main checkout before and after and warns when it changed. Nothing is pushed or merged. A verification thread is marked as one, never gets an outcome, is not drafted from and is left alone by the attendant. It is archived afterwards as the record of the run and cannot run again.


## Worked example: `@pi-kit/learn`

```
packages/pi-kit-learn/
  package.json            name @pi-kit/learn, keywords [pi-package], pi.extensions
  extensions/learn.ts     /learn [thread] and /learn verify [thread]
  lib/analysis.mjs        the prompt over the transcript, and reading the model's answer (no dependencies)
  lib/verification.mjs    a verification report as a sentence and a level for ctx.ui.notify (no dependencies)
  prompts/analyze.md      the analysis prompt (system and user sections)
  templates/SKILL.md      the shape the model is asked to write
```

`/learn` in the composer (or `pi` with pi-kit running):

1. `pi-kit:thread:transcript` for the thread (stops if it already has a draft);
2. `analysis.buildAnalysisPrompt(transcript)`;
3. `pi-kit:attendant:run` with that prompt (asking `ctx.ui.confirm` on a `consent` answer);
4. `analysis.parseDraftReply(text)`: a `SKILL.md`, or `SKIP: reason` when nothing generalises;
5. `pi-kit:learn:draft`; then `ctx.ui.notify` says to read the card.

`/learn verify [thread]`  asks the other way round: `pi-kit:learn:verified` for the thread's draft (waits for the report), then `describeVerification(report, name)` (`lib/verification.mjs`, no dependencies) turns it into one sentence and a level for `ctx.ui.notify`: "replay-notes: partial. Reproduced 5 of 6 files and 5 of 6 hunks; 1 of 1 check passes again. Read the report in the review dialog, then approve or discard the draft." The same replay starts from the review dialog (Approve with "Verify first" on, or *Verify now*), where the report is shown with its files and checks.

**The attendant's own trigger.** With the attendant on, an outcome (a worktree merged back, a commit made in the folder, a pull request) starts the same analysis without a session: pi-kit's backend loads `lib/analysis.mjs` from the installed package, so the prompt and the parsing stay in one place. It runs only when the thread looks worth it: at least 6 tool calls, at least 10 changed lines in the outcome, and no skill pi already lists whose name and description share at least 3 of the first prompt's key terms (words of four letters or more, without the common ones). It runs in the attendant's queue, under its cap and its per-project opt-out, and is listed in the activity as `learn`. Remove the package and nothing is drafted.

**Installing and removing.** The package ships inside the app (`Resources/backend/packages/pi-kit-learn`, `dist/apps/backend/packages/pi-kit-learn` in development). The first time pi-kit starts it adds that folder to the user's pi settings, the same entry `pi install <folder>` writes, once: `pi list` shows it, `pi remove <folder>` removes it, and pi-kit does not put it back (it remembers that it offered). If the app moves, the entry points at a folder that is gone; the next start points it at the new copy. `PI_KIT_LEARN_PACKAGE=off` skips the install. To get it back after a removal: `pi install <app>/Resources/backend/packages/pi-kit-learn`.

## Worked example: `@pi-kit/meat-proxy`

The second plugin has a different shape: it reads and annotates, it writes no files and runs no worktrees.

```
packages/pi-kit-meat-proxy/
  package.json            name @pi-kit/meat-proxy, keywords [pi-package], pi.extensions
  extensions/meat-proxy.ts  /score [thread]
  lib/hunks.mjs           the outcome diff split into hunks, with their ids
  lib/ledger.mjs          what the person put into the thread, without a model (no dependencies)
  lib/attribution.mjs     the prompt that asks the attendant's model to label every hunk, and the reading of its answer
  lib/score.mjs           the arithmetic and the sentence
  lib/pipeline.mjs        the whole scoring of one thread against a `host` that answers the events
  prompts/attribute.md    the attribution prompt (system and user sections)
```

`/score` in the composer (or `pi` with pi-kit running):

1. `pi-kit:thread:outcome` with `diff: true, annotations: true`, then `pi-kit:thread:transcript` (its `turns`), `pi-kit:thread:baselines` and `pi-kit:thread:outside-edits`;
2. `splitDiff(diff)` and `buildLedger(...)`: per message its specificity (named files, line numbers, commands, code), whether it corrects (a small rule set: "no", "not that", "instead", "undo", "revert", quoting pi's own words, a review comment), its chips, answers, tool calls and time; per file what led to it; the files only the person's hand changed, which are `manual` by rule and never shown to the model;
3. `pi-kit:attendant:run` with `task: 'score'` and the prompt (asking `ctx.ui.confirm` on a `consent` answer): the model labels every other hunk `specified | corrected | autonomous | manual` with the input it traces to (`prompt N`, `review N`, `hand`, `dialog`, `chip`, `none`), one line each; large outcomes are processed in batches; an incomplete model answer fails without replacing the stored score;
4. `computeScores(labels)`: Meat Proxy = the share of changed lines in specified, corrected and manual hunks, Vibe = 100 − that, with the sentence that says what it is made of ("62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand");
5. `pi-kit:thread:annotate` with the labels and the scores; then `ctx.ui.notify` says the sentence.

`lib/pipeline.mjs` is written once against a `host` (`outcome()`, `transcript()`, `baselines()`, `outsideEdits()`, `run(prompt, progress)`, `annotate(body)`): the extension's host asks over the event bus; pi-kit's backend, which scores after an outcome lands (the attendant on) and from the badge menu without a pi session, loads the same file from the installed package and answers the same questions from its own records. `progress` identifies the current batch and total batch count; the backend records that activity for each model call. The person's relabelling in the Outcome view does not call the model: pi-kit loads `computeScores` and `effectiveLabels` from the package and recomputes.

## Removable without a trace

A plugin's data stays in pi-kit's database, but **core draws it only while the package is installed in pi**. `pi remove <folder>` of `@pi-kit/meat-proxy` (pi-kit looks at pi's settings every five seconds and when a score is asked for) leaves the badge with the outcome alone (no second line, no "Score this thread" in its menu), the Outcome view with plain hunks (no meter, no labels, no relabel control), Settings › Projects and trust without the histogram, and `GET /api/threads/:id/score` answering 404. `pi install <folder>` brings all of it back from what was stored. The same package installer serves every package that ships with the app, `@pi-kit/computer-use` included (`apps/backend/src/plugins/pi-kit-package.ts`): the first start adds each shipped copy to the user's pi settings once (`PI_KIT_LEARN_PACKAGE=off`, `PI_KIT_MEAT_PROXY_PACKAGE=off`, `PI_KIT_COMPUTER_USE_PACKAGE=off` skip it; installs run one after the other so no entry is lost), and a package the user removed stays removed.

## Writing a plugin

A package needs `keywords: ["pi-package"]`, a `pi` key in `package.json` naming its extension, and nothing from pi-kit to import: the events and their payloads are plain JSON. Keep logic that should also work without pi-kit (parsing, prompts) in a module the extension imports, as `lib/analysis.mjs` is. Do not start timers or sockets in the factory; ask from a command or from `session_start`.

What a plugin may rely on:

- **Nothing reaches a skills folder, a thread or the person's files without their decision.** A draft is data until Approve.
- **Redaction first.** A transcript is masked before it leaves pi-kit's backend, whatever the plugin asks.
- **Cost is capped.** A model call is the attendant's, listed with its cost; at the day's cap the call answers `cap`.
- **Consent while the attendant is off.** The transcript goes to a model only after the person agreed for that thread.
- **Hand edits are seen, not guessed.** `pi-kit:thread:outside-edits` lists only what the folder watcher saw while no run was writing; a plugin must treat its absence as "not seen", not as "not edited".
- **A plugin never reaches into pi-kit's database.** What it lacks is added to the events and documented here (added `baselines`, `outside-edits`, `annotate`, the transcript's `turns` and the outcome's `annotations` for this reason).
