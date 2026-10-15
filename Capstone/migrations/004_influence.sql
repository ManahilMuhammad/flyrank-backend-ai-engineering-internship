-- how often each source got cited in a run and its influence
-- (influence = mean share of grounding support across all the run's answers)
ALTER TABLE source_scores
    ADD COLUMN citation_count INTEGER NOT NULL DEFAULT 0, -- answers that cited the source
    ADD COLUMN query_count    INTEGER NOT NULL DEFAULT 0, -- distinct queries whose answers cited it
    ADD COLUMN citation_rate  REAL NOT NULL DEFAULT 0;    -- citation_count / answers in run

CREATE INDEX source_scores_rank_idx ON source_scores(run_id, rank);
