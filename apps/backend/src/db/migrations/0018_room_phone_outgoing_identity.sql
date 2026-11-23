-- Retain generated IDs independently of a binding, including after unlink/relink.
CREATE TABLE room_phone_outgoing (
  account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, group_id, provider_id)
);

INSERT OR IGNORE INTO room_phone_outgoing(account_id, group_id, provider_id, created_at)
SELECT p.account_id, p.group_id, d.provider_id, COALESCE(d.sent_at, 0)
FROM room_phone_deliveries d JOIN room_phone_links p ON p.room_id = d.room_id
WHERE p.account_id IS NOT NULL AND p.group_id IS NOT NULL AND d.provider_id IS NOT NULL;
