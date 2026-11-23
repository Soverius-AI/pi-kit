-- The channel enum lives on the parent table. Rebuild the complete FK graph with FK enforcement on.
-- Copy first, then drop only the old children/parent, so ON DELETE CASCADE never reaches retained rows.
CREATE TEMP TABLE room_channel_sequence_0023 AS SELECT seq FROM sqlite_sequence WHERE name='room_channel_inbox';
ALTER TABLE room_channel_links RENAME TO room_channel_links_0023;
ALTER TABLE room_channel_prompts RENAME TO room_channel_prompts_0023;
ALTER TABLE room_channel_inbox RENAME TO room_channel_inbox_0023;
ALTER TABLE room_channel_deliveries RENAME TO room_channel_deliveries_0023;
ALTER TABLE room_channel_commands RENAME TO room_channel_commands_0023;
ALTER TABLE room_channel_outgoing RENAME TO room_channel_outgoing_0023;
CREATE TABLE room_channel_links (
 channel TEXT NOT NULL CHECK(channel IN ('whatsapp','signal','slack','telegram')),
 room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 code_hash TEXT, expires_at INTEGER, candidate_group TEXT, candidate_sender TEXT, candidate_name TEXT,
 candidate_group_name TEXT, group_id TEXT, account_id TEXT, group_name TEXT, sender_id TEXT, sender_name TEXT,
 after_seq INTEGER NOT NULL DEFAULT 0, app_url TEXT, verified_at INTEGER, binding_id TEXT,
 PRIMARY KEY(channel,room_id), UNIQUE(channel,group_id)
);
CREATE TABLE room_channel_prompts (
 channel TEXT NOT NULL, token TEXT NOT NULL, room_id TEXT NOT NULL,
 target TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('question','action','test')),
 expires_at INTEGER NOT NULL, consumed_at INTEGER,
 PRIMARY KEY(channel,token), UNIQUE(channel,room_id,target,kind),
 FOREIGN KEY(channel,room_id) REFERENCES room_channel_links(channel,room_id) ON DELETE CASCADE
);
CREATE TABLE room_channel_inbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, room_id TEXT NOT NULL,
 provider_id TEXT NOT NULL, text TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','accepted','done','review')),
 created_at INTEGER NOT NULL, raw_json TEXT, files_json TEXT NOT NULL DEFAULT '[]', quote_id TEXT,
 event_seq INTEGER, prepared_at INTEGER, work_id TEXT REFERENCES room_wakeups(id), source_key TEXT,
 UNIQUE(channel,room_id,provider_id),
 FOREIGN KEY(channel,room_id) REFERENCES room_channel_links(channel,room_id) ON DELETE CASCADE
);
CREATE TABLE room_channel_deliveries (
 channel TEXT NOT NULL, room_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','review','dismissed')),
 provider_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'reply', tries INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, delivered_at INTEGER, read_at INTEGER,
 work_id TEXT, quote_id TEXT, quote_text TEXT, prompt_id TEXT,
 PRIMARY KEY(channel,room_id,seq),
 FOREIGN KEY(channel,room_id) REFERENCES room_channel_links(channel,room_id) ON DELETE CASCADE,
 FOREIGN KEY(channel,prompt_id) REFERENCES room_channel_prompts(channel,token)
);
CREATE TABLE room_channel_commands (
 channel TEXT NOT NULL, room_id TEXT NOT NULL, provider_id TEXT NOT NULL,
 PRIMARY KEY(channel,room_id,provider_id),
 FOREIGN KEY(channel,room_id) REFERENCES room_channel_links(channel,room_id) ON DELETE CASCADE
);
CREATE TABLE room_channel_outgoing (
 channel TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
 provider_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(channel,account_id,group_id,provider_id)
);
INSERT INTO room_channel_links SELECT * FROM room_channel_links_0023;
INSERT INTO room_channel_prompts SELECT * FROM room_channel_prompts_0023;
INSERT INTO room_channel_inbox SELECT * FROM room_channel_inbox_0023;
INSERT INTO room_channel_deliveries SELECT * FROM room_channel_deliveries_0023;
INSERT INTO room_channel_commands SELECT * FROM room_channel_commands_0023;
INSERT INTO room_channel_outgoing SELECT * FROM room_channel_outgoing_0023;
DROP TABLE room_channel_commands_0023;
DROP TABLE room_channel_deliveries_0023;
DROP TABLE room_channel_inbox_0023;
DROP TABLE room_channel_prompts_0023;
DROP TABLE room_channel_links_0023;
DROP TABLE room_channel_outgoing_0023;
-- Preserve AUTOINCREMENT high-water marks even when the highest inbox rows were already deleted.
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM room_channel_sequence_0023),0)) WHERE name='room_channel_inbox';
INSERT INTO sqlite_sequence(name,seq) SELECT 'room_channel_inbox',COALESCE((SELECT MAX(seq) FROM room_channel_sequence_0023),0) WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='room_channel_inbox');
DROP TABLE room_channel_sequence_0023;
CREATE INDEX room_channel_inbox_work ON room_channel_inbox(channel,room_id,work_id);
CREATE INDEX room_channel_delivery_prompt ON room_channel_deliveries(channel,prompt_id);
