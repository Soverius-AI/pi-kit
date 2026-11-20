CREATE TABLE room_trigger_runs (
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL,
  ran_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, trigger_id)
);
