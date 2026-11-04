-- One owner identity per existing profile. No project/thread/session keys or files are rewritten.
-- The repository initializes the UUID and suggested label after this additive migration commits.
CREATE TABLE instance_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL
);

-- Approval has no age-based expiry. Raw device cookies are never kept.
-- A revocation tombstone survives a listener restart and cannot be upserted active again.
CREATE TABLE instance_device_grants (
  id TEXT PRIMARY KEY,
  cookie_hash TEXT NOT NULL UNIQUE,
  csrf TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE instance_access_preferences (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  desired_enabled INTEGER NOT NULL DEFAULT 0 CHECK (desired_enabled IN (0, 1)),
  https_port INTEGER NOT NULL DEFAULT 8443 CHECK (https_port BETWEEN 1 AND 65535)
);
INSERT INTO instance_access_preferences (singleton) VALUES (1);
