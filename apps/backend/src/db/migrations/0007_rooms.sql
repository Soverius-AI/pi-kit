CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  repository TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  base_commit TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source_thread_id TEXT,
  lead_thread_id TEXT,
  project_folder TEXT,
  lead_questions_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'supervised' CHECK (mode IN ('supervised', 'assisted')),
  paused INTEGER NOT NULL DEFAULT 0,
  agent_turns INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE room_events (
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'note', 'task')),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'lead', 'coordinator', 'worker')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  images INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  environment_id TEXT,
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE room_tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'declined', 'running', 'submitted', 'failed', 'stopped', 'integrated')),
  base TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  worker_thread_id TEXT,
  branch TEXT,
  head TEXT,
  report TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  bundle_path TEXT,
  questions_json TEXT NOT NULL DEFAULT '[]',
  a2a_token TEXT,
  a2a_task_id TEXT,
  review TEXT NOT NULL DEFAULT 'none' CHECK (review IN ('none', 'pending', 'accepted')),
  review_rounds INTEGER NOT NULL DEFAULT 0,
  lead_answers INTEGER NOT NULL DEFAULT 0,
  feedback TEXT
);

CREATE TABLE room_worker_tasks (
  task_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  worker_thread_id TEXT,
  folder TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'submitted', 'failed', 'stopped')),
  created_at INTEGER NOT NULL,
  push_url TEXT,
  push_token TEXT,
  a2a_task_id TEXT
);

CREATE TABLE room_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  path TEXT NOT NULL,
  body_json TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  token TEXT
);

CREATE INDEX room_outbox_due ON room_outbox (next_at, id);

CREATE TABLE room_directory (
  room_id TEXT PRIMARY KEY,
  host_instance_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  room_json TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reachable INTEGER NOT NULL CHECK (reachable IN (0, 1))
);

CREATE TABLE a2a_tasks (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  state TEXT NOT NULL,
  task_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);

CREATE INDEX a2a_tasks_context ON a2a_tasks (owner, context_id, updated_at);

CREATE TABLE a2a_push_configs (
  owner TEXT NOT NULL,
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  wire_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, task_id, id)
);

CREATE TABLE a2a_agents (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  token_storage TEXT NOT NULL CHECK (token_storage IN ('none', 'keychain', 'database')),
  token TEXT,
  created_at INTEGER NOT NULL
);
