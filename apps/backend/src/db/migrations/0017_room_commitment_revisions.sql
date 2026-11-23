-- Owner edits invalidate older scheduled work, including a result still being generated.
ALTER TABLE room_commitments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_wakeups ADD COLUMN commitment_revision INTEGER;
ALTER TABLE room_wakeups ADD COLUMN started_at INTEGER;
