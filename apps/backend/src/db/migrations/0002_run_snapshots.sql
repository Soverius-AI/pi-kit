-- What changed in a thread comes from snapshots of its folder around each run (trees in a private git repository, see `ShadowRepo`):
-- `folder` is where the run worked, `start_tree` the folder before pi got the prompt, `end_tree` the folder when the run ended. NULL where the
-- folder is not in a git work tree. `shadow_dir` and `shadow_prefix` say where that repository is and which folder of the project its paths are relative
-- to, so the snapshots stay readable after the folder is gone (a worktree merged back and removed). They replace the copies of files from before pi's
-- first edit and the record of changes made by hand.
ALTER TABLE runs ADD COLUMN folder TEXT;
ALTER TABLE runs ADD COLUMN shadow_dir TEXT;
ALTER TABLE runs ADD COLUMN shadow_prefix TEXT;
ALTER TABLE runs ADD COLUMN start_tree TEXT;
ALTER TABLE runs ADD COLUMN end_tree TEXT;
DROP TABLE change_baselines;
DROP TABLE thread_outside_edits;
