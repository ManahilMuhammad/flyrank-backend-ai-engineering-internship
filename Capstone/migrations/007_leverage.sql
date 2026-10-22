-- leverage = influence x deficit
-- leverage_rank orders action list - null for sources with nothing to fix or no verdict
ALTER TABLE source_scores
    ADD COLUMN leverage_rank INTEGER,
    ADD COLUMN action TEXT CHECK (action IN ('correct_stale_info', 'get_included', 'address_criticism', 'improve_mention'));

CREATE INDEX source_scores_leverage_idx ON source_scores(run_id, leverage_rank);
