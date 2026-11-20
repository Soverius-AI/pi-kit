ALTER TABLE rooms ADD COLUMN playbook TEXT;
ALTER TABLE rooms ADD COLUMN stage TEXT;

CREATE TABLE room_events_next (
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'note', 'task')),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'lead', 'coordinator', 'worker', 'consultant')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  images INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  environment_id TEXT,
  role TEXT,
  PRIMARY KEY (room_id, seq)
);
INSERT INTO room_events_next (room_id, seq, kind, actor, text, created_at, images, task_id, environment_id)
  SELECT room_id, seq, kind, actor, text, created_at, images, task_id, environment_id FROM room_events;
DROP TABLE room_events;
ALTER TABLE room_events_next RENAME TO room_events;

CREATE TABLE room_memory (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE room_actions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'advance')),
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'discarded')),
  result TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX room_actions_room ON room_actions (room_id, created_at);

CREATE TABLE room_trigger_seen (
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, trigger_id, item_key)
);

CREATE TABLE room_consult_threads (
  thread_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
