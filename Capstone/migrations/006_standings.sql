-- cited pages coming from sites the brand owns (e.g. flyrank.ai) labelled owned
-- so not audited as third-party
ALTER TABLE brands ADD COLUMN domains TEXT[] NOT NULL DEFAULT '{}';

-- why scored source has no standing (not fetched, owned, audit rejected...)
-- standing_id (already on source_scores) points at verdict when there is one
ALTER TABLE source_scores ADD COLUMN audit_note TEXT;

CREATE INDEX standings_brand_idx ON standings(brand_id, snapshot_id);
