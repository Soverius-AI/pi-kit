-- A background agent that works in its thread's folder (not in a worktree of its own) changes the folder outside the thread's runs: each stretch of
-- its work is snapshotted like a run, `start_tree` before it gets the work and `end_tree` (NULL while it works) when it stops. What changed between
-- the two is the thread's, as a run's changes are. `shadow_dir` and `shadow_prefix` say where the snapshots are, as on `runs`.
CREATE TABLE agent_spans (
  id            INTEGER PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  folder        TEXT NOT NULL,
  shadow_dir    TEXT NOT NULL,
  shadow_prefix TEXT NOT NULL,
  start_tree    TEXT NOT NULL,
  end_tree      TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX agent_spans_thread ON agent_spans (thread_id, started_at);
CREATE INDEX agent_spans_open ON agent_spans (agent_id) WHERE end_tree IS NULL;
