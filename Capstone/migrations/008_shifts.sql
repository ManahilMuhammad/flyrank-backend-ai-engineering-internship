-- opt-in weekly re-harvest per category 
-- (off by default so test categories never spend llm quota)
ALTER TABLE categories ADD COLUMN weekly_harvest BOOLEAN NOT NULL DEFAULT false;

-- shift events written per run 
-- (rewritten if run re-audited)
CREATE INDEX shift_events_run_idx ON shift_events(run_id);
