-- Public identity metadata only. The private signing key stays OS-sealed outside this database.
CREATE TABLE instance_peer_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  public_key_json TEXT,
  fingerprint TEXT,
  public_origin TEXT
);
INSERT INTO instance_peer_identity(singleton) VALUES (1);

CREATE TABLE instance_peers (
  peer_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL,
  alias TEXT,
  confirmation_code TEXT CHECK (confirmation_code IS NULL OR length(confirmation_code) = 6),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  pair_role TEXT NOT NULL CHECK (pair_role IN ('inviter', 'joiner')),
  allow_relay INTEGER NOT NULL CHECK (allow_relay IN (0, 1)),
  remote_allow_relay INTEGER NOT NULL CHECK (remote_allow_relay IN (0, 1)),
  share_devices INTEGER NOT NULL CHECK (share_devices IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  unpair_pending INTEGER NOT NULL DEFAULT 0 CHECK (unpair_pending IN (0, 1))
);

-- Pairing a new peer never silently expands old phone scopes: an owner must explicitly share it.
CREATE TABLE instance_device_peers (
  device_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  PRIMARY KEY (device_id, peer_id)
);
