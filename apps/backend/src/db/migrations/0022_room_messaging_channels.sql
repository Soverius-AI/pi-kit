CREATE TABLE room_channel_links (
 channel TEXT NOT NULL CHECK(channel IN ('whatsapp','signal','slack')),
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
INSERT INTO room_channel_links SELECT 'whatsapp',room_id,code_hash,expires_at,candidate_group,candidate_sender,candidate_name,candidate_group_name,group_id,account_id,group_name,sender_id,sender_name,after_seq,app_url,verified_at,binding_id FROM room_phone_links;
INSERT INTO room_channel_prompts SELECT 'whatsapp',token,room_id,target,kind,expires_at,consumed_at FROM room_phone_prompts;
INSERT INTO room_channel_inbox SELECT id,'whatsapp',room_id,provider_id,text,state,created_at,raw_json,files_json,quote_id,event_seq,prepared_at,work_id,source_key FROM room_phone_inbox;
INSERT INTO room_channel_deliveries SELECT 'whatsapp',room_id,seq,text,state,provider_id,kind,tries,next_at,sent_at,delivered_at,read_at,work_id,quote_id,quote_text,prompt_id FROM room_phone_deliveries;
INSERT INTO room_channel_commands SELECT 'whatsapp',room_id,provider_id FROM room_phone_commands;
INSERT INTO room_channel_outgoing SELECT 'whatsapp',account_id,group_id,provider_id,created_at FROM room_phone_outgoing;
DROP TABLE room_phone_commands;
DROP TABLE room_phone_deliveries;
DROP TABLE room_phone_inbox;
DROP TABLE room_phone_prompts;
DROP TABLE room_phone_links;
DROP TABLE room_phone_outgoing;
CREATE INDEX room_channel_inbox_work ON room_channel_inbox(channel,room_id,work_id);
CREATE INDEX room_channel_delivery_prompt ON room_channel_deliveries(channel,prompt_id);
