ALTER TABLE rooms ADD COLUMN workspace_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE room_assistant_policy (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id), policy TEXT NOT NULL
);
CREATE TABLE room_commitments (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), title TEXT NOT NULL, details TEXT NOT NULL,
  due_at INTEGER NOT NULL, timezone TEXT NOT NULL, daily_at TEXT, source TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','done','cancelled')), last_fired_at INTEGER
);
CREATE INDEX room_commitments_due ON room_commitments(state, due_at);
CREATE TABLE room_folders (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), alias TEXT NOT NULL, target TEXT NOT NULL,
  canonical TEXT NOT NULL, environment_id TEXT NOT NULL, UNIQUE(room_id, alias)
);
CREATE TABLE room_wakeups (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), source_key TEXT NOT NULL,
  title TEXT NOT NULL, text TEXT NOT NULL, cause_json TEXT NOT NULL, images_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed','review')),
  owner_seq INTEGER, result_seq INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(room_id, source_key)
);
CREATE INDEX room_wakeups_queue ON room_wakeups(room_id, state, created_at);
