-- report recipients: category's own list else workspace owners' login emails
ALTER TABLE categories ADD COLUMN report_recipients TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE workspace_members ADD COLUMN email TEXT; -- from supabase at login; null until the member next signs in

-- pdf lives in database (served by api, works with several app instances, no files to clean up)
ALTER TABLE reports
    DROP COLUMN pdf_path,
    ADD COLUMN pdf         BYTEA NOT NULL,
    ADD COLUMN recipients  TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN email_error TEXT,
    ADD COLUMN updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();
