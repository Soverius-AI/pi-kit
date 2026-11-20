ALTER TABLE rooms ADD COLUMN rehearsal INTEGER NOT NULL DEFAULT 0;

-- SQLite cannot widen a CHECK in place: rebuild room_actions so it also holds proposed playbook files.
CREATE TABLE room_actions_next (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'advance', 'playbook')),
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'discarded')),
  result TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

INSERT INTO room_actions_next SELECT id, room_id, kind, name, payload_json, summary, state, result, created_at, decided_at FROM room_actions;

DROP TABLE room_actions;

ALTER TABLE room_actions_next RENAME TO room_actions;

CREATE INDEX room_actions_room ON room_actions (room_id, created_at);
