ALTER TABLE room_events ADD COLUMN work_id TEXT;
ALTER TABLE room_phone_links ADD COLUMN app_url TEXT;
ALTER TABLE room_phone_links ADD COLUMN verified_at INTEGER;
ALTER TABLE room_phone_inbox ADD COLUMN raw_json TEXT;
ALTER TABLE room_phone_inbox ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE room_phone_inbox ADD COLUMN quote_id TEXT;
ALTER TABLE room_phone_inbox ADD COLUMN event_seq INTEGER;
ALTER TABLE room_phone_inbox ADD COLUMN prepared_at INTEGER;
ALTER TABLE room_phone_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply';
ALTER TABLE room_phone_deliveries ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_phone_deliveries ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_phone_deliveries ADD COLUMN sent_at INTEGER;
ALTER TABLE room_phone_deliveries ADD COLUMN delivered_at INTEGER;
ALTER TABLE room_phone_deliveries ADD COLUMN read_at INTEGER;
ALTER TABLE room_phone_deliveries ADD COLUMN work_id TEXT;
ALTER TABLE room_phone_deliveries ADD COLUMN quote_id TEXT;
ALTER TABLE room_phone_deliveries ADD COLUMN quote_text TEXT;
UPDATE room_phone_deliveries SET provider_id='3EB0'||upper(hex(randomblob(9))) WHERE provider_id IS NULL;
CREATE TABLE room_phone_prompts (
  token TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES room_phone_links(room_id),
  target TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('question','action','test')),
  expires_at INTEGER NOT NULL, consumed_at INTEGER, UNIQUE(room_id,target,kind)
);
CREATE TABLE room_phone_commands (room_id TEXT NOT NULL, provider_id TEXT NOT NULL, PRIMARY KEY(room_id,provider_id));
