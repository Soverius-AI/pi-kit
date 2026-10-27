-- pi-kit metadata. pi's session files stay the source of truth for conversations;
-- these tables hold only what the UI needs on top: thread flags, the AG-UI replay log, run locks and what the attendant and the score keep.

CREATE TABLE threads (
  id                  TEXT PRIMARY KEY,               -- == pi session id
  session_path        TEXT NOT NULL,                  -- the JSONL file; rewritten if pi creates it elsewhere
  cwd                 TEXT NOT NULL,
  title               TEXT,                           -- pi session_info name, NULL until named
  preview             TEXT,                           -- first user message, the fallback title
  pinned              INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  origin              TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'cli')),
  parent_session_path TEXT,                           -- fork and clone source, from the session header
  message_count       INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  last_opened_at      INTEGER,
  updated_at          INTEGER NOT NULL,               -- last change of the session file
  log_mtime           INTEGER,                        -- session file mtime when thread_events last matched it
  fork_count          INTEGER NOT NULL DEFAULT 0,     -- extra branches in the tree, for the sidebar's "N forks"
  fork_count_at       INTEGER,                        -- session file mtime fork_count was computed for
  leaf_id             TEXT,                           -- the leaf the app moved to (pi persists a leaf only by appending)
  leaf_mtime          INTEGER,                        -- session file mtime leaf_id belongs to; a newer file means the CLI moved on
  -- When the user last looked at the thread; a run that ended after it is "unread".
  seen_at             INTEGER,
  -- The share of the model's window in use at the end of the thread's last response, and the session file mtime it was measured for.
  context_pct         INTEGER,
  context_at          INTEGER,
  -- A thread that runs in a git worktree of a project: `project_cwd` is the main checkout (the thread stays listed under it), `worktree_path`
  -- the folder pi runs in while the worktree exists (NULL once it was removed), `branch` the branch it was created on, `base_branch` the
  -- branch it was cut from and is merged back into. `cwd` stays what pi's session file says (the worktree folder).
  worktree_path       TEXT,
  branch              TEXT,
  project_cwd         TEXT,
  base_branch         TEXT,
  -- The commit the folder was on when the thread started. `base_source` says where it came from: 'start' (captured when the thread began),
  -- 'estimated' (`git rev-list -1 --before=<first message>`), or 'none' (not a git folder, or no commit that old); NULL means "not looked at yet".
  base_commit         TEXT,
  base_source         TEXT CHECK (base_source IN ('start', 'estimated', 'none')),
  -- The first line of the last assistant message, for the sidebar's summary line when the attendant has no summary, and the mtime it was read for.
  last_line           TEXT,
  last_line_at        INTEGER
);
CREATE INDEX threads_cwd ON threads (cwd);
CREATE UNIQUE INDEX threads_session_path ON threads (session_path);
CREATE INDEX threads_worktree ON threads (worktree_path) WHERE worktree_path IS NOT NULL;

-- The AG-UI replay log. SQLite allocates `seq` across all writers: a thread's IDs increase but can have gaps. Compaction deletes rows, never renumbers.
CREATE TABLE thread_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  run_id     TEXT,
  event_json TEXT NOT NULL,
  type       TEXT NOT NULL
);
-- Every streamed delta is a row, so the log keeps only the indexes its reads need: the thread's events in order, and where its snapshots are
-- (compaction starts from the newest one). The rare pass over a thread's runs scans the thread's events.
CREATE INDEX thread_events_thread ON thread_events (thread_id, seq);
CREATE INDEX thread_events_snapshot ON thread_events (thread_id, seq) WHERE type = 'MESSAGES_SNAPSHOT';

-- One row per run. The partial unique index is the lock: at most one 'running' row per thread.
CREATE TABLE runs (
  run_id     TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('running', 'finished', 'error', 'aborted')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE UNIQUE INDEX runs_one_active ON runs (thread_id) WHERE status = 'running';
CREATE INDEX runs_thread ON runs (thread_id, started_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

-- A project is a known workspace folder. `sort_order` is the order of the sidebar (1..n), `collapsed` and `hidden` are the group's state,
-- `attendant_off` and `agents_off` are the per-project opt-outs. `forgotten` takes a folder off the sidebar and the Projects list without
-- touching its threads or files; the row stays so its settings come back if the folder is added again.
CREATE TABLE workspaces (
  cwd              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  last_opened_at   INTEGER NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  collapsed        INTEGER NOT NULL DEFAULT 0,
  hidden           INTEGER NOT NULL DEFAULT 0,
  attendant_off    INTEGER NOT NULL DEFAULT 0,
  -- Where worktrees go (NULL: ~/.pi-kit/worktrees or PI_KIT_WORKTREE_ROOT) and the branch they are cut from (NULL: the branch that is checked out).
  worktree_root    TEXT,
  worktree_base    TEXT,
  -- The "New threads" and "Worktrees" settings the Where row of the new-thread page reads. All NULL means the default (start: local, branch
  -- switching on, carry: ask, branch named with the prefix `pi-kit/`, remove the folder: ask).
  wt_start         TEXT CHECK (wt_start IN ('local', 'worktree', 'ask')),
  wt_allow_switch  INTEGER,
  wt_carry         TEXT CHECK (wt_carry IN ('ask', 'always', 'never')),
  wt_branch_mode   TEXT CHECK (wt_branch_mode IN ('named', 'detached')),
  wt_branch_prefix TEXT,
  wt_remove        TEXT CHECK (wt_remove IN ('ask', 'now', 'after-7-days', 'never')),
  -- The setup scripts as JSON: [{ id, name, command, copy? }], the first being the default. NULL: never configured (the lockfile of the
  -- project suggests one); '[]': the person said none.
  wt_scripts       TEXT,
  forgotten        INTEGER NOT NULL DEFAULT 0,
  agents_off       INTEGER NOT NULL DEFAULT 0
);

-- The pending review batch of a thread, mirrored from the renderer so a reload keeps it. A comment is pending until the
-- batch is sent; sending records it in the pi session (a `pi-kit.review` custom entry) and removes it from here.
CREATE TABLE review_comments (
  thread_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  position   INTEGER NOT NULL,                       -- order the renderer holds them in
  file       TEXT NOT NULL,                          -- relative to the thread's folder
  side       TEXT NOT NULL CHECK (side IN ('old', 'new')),
  line       INTEGER NOT NULL,
  snippet    TEXT NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (thread_id, id)
) WITHOUT ROWID;
CREATE INDEX review_comments_order ON review_comments (thread_id, position);

-- A file as it was when the first `edit` / `write` of the thread started: the "before" side of the "This thread" diff.
-- `content` is NULL when the file could not be kept (binary, or too large); the diff then falls back to git. A rowid table: a row can hold
-- megabytes, which WITHOUT ROWID tables store badly. Pruned 30 days after the thread's session last changed.
CREATE TABLE change_baselines (
  thread_id   TEXT NOT NULL,
  path        TEXT NOT NULL,                         -- relative to the thread's folder
  existed     INTEGER NOT NULL,                      -- 0: pi created the file
  content     TEXT,
  captured_at INTEGER NOT NULL,
  UNIQUE (thread_id, path)
);

-- Thumbs up / down on assistant messages. `message_id` is the pi entry id of the assistant message (the AG-UI message id
-- once a run's history snapshot is applied). One rating per message; clearing a rating deletes the row.
CREATE TABLE feedback (
  thread_id  TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rating     TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, message_id)
) WITHOUT ROWID;

-- What the attendant knows about a thread. `summary_for` is the session file's mtime the summary describes, `looked_for` the mtime of the
-- file the last time the attendant went over the thread; both keep it from working twice on a file that did not change.
CREATE TABLE thread_meta (
  thread_id          TEXT PRIMARY KEY,
  summary            TEXT,
  summary_for        INTEGER,
  looked_for         INTEGER
) WITHOUT ROWID;

-- Everything the attendant did or declined to do ("Attendant activity"), with what the model cost. Rows older than 90 days are pruned.
CREATE TABLE attendant_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('title', 'summary', 'label', 'draft', 'learn', 'score', 'prompt')),
  status        TEXT NOT NULL CHECK (status IN ('done', 'skipped', 'error')),
  thread_id     TEXT,
  thread_title  TEXT,
  text          TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost          REAL NOT NULL DEFAULT 0
);
CREATE INDEX attendant_actions_at ON attendant_actions (at DESC);

-- Proposals the user may accept: a label for a fork point, an answer to a mechanical question, a draft to read, a follow-up prompt.
-- Nothing here is applied by itself. Settled follow-up prompts are pruned except each thread's newest.
CREATE TABLE thread_suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('label', 'answer', 'learn', 'prompt')),
  target     TEXT NOT NULL,
  text       TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'dismissed'))
);
-- Lookups by target (one open suggestion per target, "was this proposed before?"), and the open ones the status snapshot lists.
CREATE INDEX thread_suggestions_target ON thread_suggestions (thread_id, kind, target);
CREATE INDEX thread_suggestions_open ON thread_suggestions (id) WHERE state = 'open';

-- The last screen of each workspace's terminal, so a restart of the backend shows it again. `data` is already redacted
-- (libs/shared/protocol redact.ts) when it is written; up to 256 KB, so a rowid table. A screen of a folder that is no longer a project or a
-- thread's folder, or that nobody looked at for 30 days, is pruned.
CREATE TABLE terminal_replay (
  cwd         TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Soft leases: which thread edited or wrote which file, and when it last did. `path` is relative to `cwd` (the folder the thread runs in).
-- A lease counts for 30 minutes after `at`; `since` is when the thread first took it.
CREATE TABLE file_leases (
  thread_id TEXT NOT NULL,
  cwd       TEXT NOT NULL,
  path      TEXT NOT NULL,
  since     INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (thread_id, cwd, path)
) WITHOUT ROWID;
CREATE INDEX file_leases_cwd ON file_leases (cwd, at);

-- One row per thread: the latest outcome. `merged`: head is the merge commit on the base branch. `pr`: head is the branch tip, `pr_url` the pull request.
-- `committed`: head is the newest commit attributed to the thread; later commits that overlap its files move `head_commit` and grow `files`.
-- `files` is a JSON array of paths relative to the folder the thread works in. `scores` and `hunk_labels` are the Meat Proxy Score's,
-- written by the score service when the thread is scored; NULL until then.
CREATE TABLE thread_outcomes (
  thread_id    TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('merged', 'committed', 'pr')),
  base_commit  TEXT NOT NULL,
  head_commit  TEXT NOT NULL,
  merge_commit TEXT,
  pr_url       TEXT,
  at           INTEGER NOT NULL,
  files        TEXT NOT NULL DEFAULT '[]',
  scores       TEXT,
  hunk_labels  TEXT
) WITHOUT ROWID;

-- Skills drafted from finished threads. A draft lives here, never in a skills folder: pi cannot see it, and the only writer of a
-- folder is the approve route. `state` is pending until the person approves (the folder is written, `path` says where) or discards (nothing is
-- written; the thread is not drafted again, and the draft can be reopened). `verification` is the "Verify" report, JSON, NULL until one ran.
-- Retire moves the folder to `.retired/` (never deletes) and sets `retired_at`; Restore clears it. NULL: the skill is live.
CREATE TABLE skill_drafts (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  text         TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('project', 'user')),
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'discarded')),
  verification TEXT,
  made_by      TEXT NOT NULL DEFAULT 'attendant' CHECK (made_by IN ('attendant', 'person')),
  model        TEXT,
  path         TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  retired_at   INTEGER
) WITHOUT ROWID;
-- One draft per thread: a discarded one is the memory that the thread is not drafted again.
CREATE UNIQUE INDEX skill_drafts_thread ON skill_drafts (thread_id);
CREATE INDEX skill_drafts_state ON skill_drafts (state);

-- The record of a learned skill. Every use of a skill whose SKILL.md carries `x-pi-kit.learnedFrom` is a row, written when the prompt is sent:
-- the thread it was learned from (what the record is keyed by, so a copy of the skill in a worktree still counts for it), the thread it was used in
-- and when. `outcome` is the kind of the using thread's outcome once it lands one: that is what "merged after use" counts.
CREATE TABLE skill_uses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  learned_from TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  at           INTEGER NOT NULL,
  outcome      TEXT CHECK (outcome IN ('merged', 'committed', 'pr'))
);
CREATE INDEX skill_uses_learned ON skill_uses (learned_from, at DESC);
CREATE INDEX skill_uses_thread ON skill_uses (thread_id);

-- Files of a thread's folder that changed while no run of pi was writing, as the folder watcher saw them: changes by hand. One row per thread and file;
-- `count` is the number of watcher batches that reported it. Read through `pi-kit:thread:outside-edits`; deleted with the thread.
CREATE TABLE thread_outside_edits (
  thread_id TEXT NOT NULL,
  path      TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (thread_id, path)
) WITHOUT ROWID;

-- The dialogs a person answered: the question, and what they said. pi keeps none of it and the replay log is compacted at the end of a run, so the ledger
-- (`pi-kit:thread:transcript`, `turns[].answers`) has nothing to read without this. `value` is the choice or the text (cut to 300 characters); a dismissal is `cancelled`.
CREATE TABLE thread_dialog_answers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  method    TEXT NOT NULL,
  title     TEXT NOT NULL,
  status    TEXT NOT NULL,
  confirmed INTEGER,
  value     TEXT
);
CREATE INDEX thread_dialog_answers_thread ON thread_dialog_answers (thread_id, at);

-- The index and history of the background agents. The id is the agent's pi-durable conversation id; transcripts and task state stay in the
-- durable store (bg-agents.sqlite). `owner_epoch` is the store owner's epoch at the last write: an older owner cannot overwrite a newer one's row.
CREATE TABLE bg_agents (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  model         TEXT,
  permission    TEXT NOT NULL CHECK (permission IN ('read-only', 'edit', 'isolated')),
  brief         TEXT NOT NULL,
  submission_id TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'done', 'failed', 'stopped')),
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  cost          REAL NOT NULL DEFAULT 0,
  report        TEXT,
  cleanup_json  TEXT,
  failures_json TEXT NOT NULL DEFAULT '[]',
  owner_epoch   INTEGER NOT NULL
);
CREATE INDEX bg_agents_thread ON bg_agents (thread_id, created_at);
