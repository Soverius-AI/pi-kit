-- Reserve approved external operations before executing them. Unknown outcomes
-- are reviewed after restart; known results can finish their database settlement.
CREATE TABLE room_action_executions (
  action_id TEXT PRIMARY KEY REFERENCES room_actions(id),
  settlement_json TEXT, started_at INTEGER NOT NULL
);

-- Reissue pending phone requests with explicit prompt relations; old tokens stop working.
DELETE FROM room_phone_prompts;
