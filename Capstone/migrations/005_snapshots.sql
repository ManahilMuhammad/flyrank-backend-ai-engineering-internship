-- snapshot row per distinct extracted text (ok) or failed attempt
-- checked_at = what it says last time fetch confirmed so newest checked_at = page's current state
ALTER TABLE source_snapshots
    ADD COLUMN checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN final_url     TEXT, -- after redirects
    ADD COLUMN etag          TEXT, -- for conditional requests next time
    ADD COLUMN last_modified TEXT,
    ADD COLUMN error         TEXT;

DROP INDEX source_snapshots_latest_idx;
CREATE INDEX source_snapshots_latest_idx ON source_snapshots(source_id, checked_at DESC);

-- which snapshot each run's scored source was read from
ALTER TABLE source_scores ADD COLUMN snapshot_id UUID REFERENCES source_snapshots(id) ON DELETE SET NULL;
