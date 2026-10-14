-- record where each query came from so generated sets can be audited
-- and regenerated without touching queries user added by hand
ALTER TABLE queries
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('generated', 'manual')),
    ADD COLUMN generation_model TEXT; -- null for manual queries

CREATE INDEX queries_category_idx ON queries(category_id, created_at);
