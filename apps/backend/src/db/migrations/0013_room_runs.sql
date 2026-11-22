CREATE TABLE room_runs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  cause TEXT NOT NULL CHECK (cause IN ('owner', 'schedule', 'poll', 'approval', 'stage', 'agent')),
  trigger_id TEXT,
  title TEXT NOT NULL,
  playbook TEXT,
  stage TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'stopped')),
  summary TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (room_id, number)
);

CREATE INDEX room_runs_room ON room_runs (room_id, started_at);

CREATE TABLE room_run_steps (
  run_id TEXT NOT NULL REFERENCES room_runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'output', 'consult', 'advance')),
  name TEXT NOT NULL,
  detail TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'discarded')),
  output TEXT,
  action_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX room_run_steps_action ON room_run_steps (action_id);
