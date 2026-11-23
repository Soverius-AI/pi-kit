-- Human messaging is separate from the agent-to-agent outbox.
CREATE TABLE room_phone_links (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  code_hash TEXT,
  expires_at INTEGER,
  candidate_group TEXT,
  candidate_sender TEXT,
  candidate_name TEXT,
  candidate_group_name TEXT,
  group_id TEXT UNIQUE,
  account_id TEXT,
  group_name TEXT,
  sender_id TEXT,
  sender_name TEXT,
  after_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE room_phone_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES room_phone_links(room_id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'dispatching', 'accepted', 'done', 'review')),
  created_at INTEGER NOT NULL,
  UNIQUE(room_id, provider_id)
);

CREATE TABLE room_phone_deliveries (
  room_id TEXT NOT NULL REFERENCES room_phone_links(room_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'sending', 'sent', 'review', 'dismissed')),
  provider_id TEXT,
  PRIMARY KEY(room_id, seq)
);
