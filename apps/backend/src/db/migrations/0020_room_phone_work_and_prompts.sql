ALTER TABLE room_phone_links ADD COLUMN binding_id TEXT;
UPDATE room_phone_links SET binding_id=lower(hex(randomblob(16))) WHERE group_id IS NOT NULL;
ALTER TABLE room_phone_inbox ADD COLUMN work_id TEXT REFERENCES room_wakeups(id);
ALTER TABLE room_phone_inbox ADD COLUMN source_key TEXT;
UPDATE room_phone_inbox SET source_key=(SELECT 'phone:'||p.account_id||':'||p.group_id||':'||room_phone_inbox.provider_id FROM room_phone_links p WHERE p.room_id=room_phone_inbox.room_id);
UPDATE room_phone_inbox SET work_id=(SELECT w.id FROM room_wakeups w WHERE w.room_id=room_phone_inbox.room_id AND w.source_key=room_phone_inbox.source_key);
ALTER TABLE room_phone_deliveries ADD COLUMN prompt_id TEXT REFERENCES room_phone_prompts(token) ON DELETE SET NULL;
-- Older prompt deliveries have no relation; dismiss unsent command prompts rather than infer identity from message text.
UPDATE room_phone_deliveries SET state='dismissed' WHERE state IN ('pending','sending') AND kind IN ('question','action','test');
UPDATE room_phone_prompts SET consumed_at=COALESCE(consumed_at,0);
