-- what answer engine returned as is (groq: answer with citation markers and every page opened)
-- kept so citation parsing can be checked and re-run so evaluation can see exactly what engine read
ALTER TABLE answers ADD COLUMN engine_response JSONB;
