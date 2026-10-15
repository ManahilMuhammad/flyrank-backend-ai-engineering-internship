-- at most one queued or running harvest per category
-- enforced so two simultaneous requests cant start one
CREATE UNIQUE INDEX harvest_runs_one_active_idx ON harvest_runs(category_id)
    WHERE status IN ('queued', 'running');

-- google searches gemini ran for each answer
ALTER TABLE answers ADD COLUMN search_queries TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX answers_run_idx ON answers(run_id, query_id, sample_n);
