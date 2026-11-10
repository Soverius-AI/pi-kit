-- A thread's execution protection, kept apart from its transcript so navigating history cannot reset it.
CREATE TABLE thread_protection (
  thread_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('bypass', 'sandboxed')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  windows_accepted INTEGER NOT NULL CHECK (windows_accepted IN (0, 1))
);

-- A sandbox that has not confirmed its shutdown. A row left by an earlier process holds its owner for recovery.
CREATE TABLE sandbox_owners (
  owner_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'recovery-required'))
);
