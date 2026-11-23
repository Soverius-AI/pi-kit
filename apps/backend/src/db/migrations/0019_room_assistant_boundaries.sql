-- Freeze the legacy behavior once. Null timezone is resolved to the host timezone
-- on first access. Legacy playbooks retain their previously uncapped model runs.
INSERT OR IGNORE INTO room_assistant_policy(room_id,policy)
SELECT id,json_object('enabled',json(CASE WHEN playbook IS NULL THEN 'false' ELSE 'true' END),
  'timezone',NULL,'quietStart','22:00','quietEnd','08:00','dailyLimit',10)
FROM rooms;

ALTER TABLE rooms ADD COLUMN workspace_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_folders ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;
UPDATE room_folders SET automatic=1 WHERE alias='project'
  AND target=(SELECT project_folder FROM rooms WHERE id=room_folders.room_id);
UPDATE rooms SET workspace_mode=1 WHERE EXISTS
  (SELECT 1 FROM room_folders WHERE room_id=rooms.id AND automatic=0);
