-- Schema
-- Tenant-owned tables carry workspace_id (directly or through parent)
-- sources and source_snapshots global on purpose: two workspaces tracking
-- same category share one fetch + hash per URL

-- ---------- tenancy ----------
CREATE TABLE workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL, -- supabase auth user id
    role         TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

-- ---------- what is being tracked ----------
CREATE TABLE brands (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    aliases      TEXT[] NOT NULL DEFAULT '{}',
    fact_sheet   JSONB NOT NULL DEFAULT '{}', -- current pricing etc
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX brands_workspace_idx ON brands(workspace_id);

CREATE TABLE categories (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    brand_id     UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX categories_workspace_idx ON categories(workspace_id);

CREATE TABLE queries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    intent      TEXT,                                            -- e.g. comparison, pricing, alternatives
    variant_of  UUID REFERENCES queries(id) ON DELETE SET NULL,  -- paraphrase of another query
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (category_id, text)
);

-- ---------- harvesting ----------
CREATE TABLE harvest_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id       UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    engine            TEXT NOT NULL DEFAULT 'gemini',
    model             TEXT NOT NULL,
    samples_per_query SMALLINT NOT NULL DEFAULT 3,
    status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    stats             JSONB NOT NULL DEFAULT '{}',
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ
);
CREATE INDEX harvest_runs_category_idx ON harvest_runs(category_id, created_at DESC);

-- one row per (query, sample) - answers non-deterministic so each query sampled N times
CREATE TABLE answers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES harvest_runs(id) ON DELETE CASCADE,
    query_id        UUID NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
    sample_n        SMALLINT NOT NULL,
    answer_text     TEXT,
    brand_mentioned BOOLEAN,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, query_id, sample_n)
);

CREATE TABLE sources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_canonical TEXT NOT NULL UNIQUE,
    domain        TEXT NOT NULL,
    source_type   TEXT,  -- forum, review_platform, editorial, vendor, video, other
    title         TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sources_domain_idx ON sources(domain);

-- Gemini grounding returns redirect URLs; cache what each one resolves to
CREATE TABLE url_resolutions (
    redirect_url TEXT PRIMARY KEY,
    resolved_url TEXT,
    resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- join table: which sources an answer was grounded in, how much each supports
CREATE TABLE citations (
    answer_id      UUID NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
    source_id      UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    support_weight REAL NOT NULL DEFAULT 0,
    chunk_index    SMALLINT,
    PRIMARY KEY (answer_id, source_id)
);
CREATE INDEX citations_source_idx ON citations(source_id);

-- ---------- auditing ----------
-- new snapshot only exists when page content changes (content-hash cache)
CREATE TABLE source_snapshots (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id      UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    content_hash   TEXT,
    extracted_text TEXT,
    fetch_status   TEXT NOT NULL
                   CHECK (fetch_status IN ('ok', 'fetch_failed', 'blocked_robots', 'unsupported')),
    http_status    INTEGER,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, content_hash)
);
CREATE INDEX source_snapshots_latest_idx ON source_snapshots(source_id, fetched_at DESC);

-- one classification per (snapshot, brand, prompt version): unchanged page = no new LLM call
CREATE TABLE standings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id      UUID NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
    brand_id         UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    stance           TEXT NOT NULL CHECK (stance IN ('absent', 'neutral', 'favorable', 'unfavorable')),
    is_stale         BOOLEAN NOT NULL DEFAULT FALSE,
    stale_reason     TEXT,
    evidence_passage TEXT,  -- verbatim excerpt from page
    confidence       REAL,
    model            TEXT NOT NULL,
    prompt_version   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (snapshot_id, brand_id, prompt_version)
);

-- ---------- outputs ----------
CREATE TABLE source_scores (
    run_id      UUID NOT NULL REFERENCES harvest_runs(id) ON DELETE CASCADE,
    source_id   UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    standing_id UUID REFERENCES standings(id) ON DELETE SET NULL,
    influence   REAL NOT NULL,
    deficit     REAL,
    leverage    REAL,
    rank        INTEGER,
    PRIMARY KEY (run_id, source_id)
);

CREATE TABLE shift_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    run_id      UUID NOT NULL REFERENCES harvest_runs(id) ON DELETE CASCADE,
    prev_run_id UUID REFERENCES harvest_runs(id) ON DELETE SET NULL,
    type        TEXT NOT NULL CHECK (type IN
                ('source_entered', 'source_exited', 'standing_changed', 'citation_rate_changed')),
    source_id   UUID REFERENCES sources(id) ON DELETE SET NULL,
    delta       REAL,
    payload     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shift_events_category_idx ON shift_events(category_id, created_at DESC);

CREATE TABLE reports (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     UUID NOT NULL UNIQUE REFERENCES harvest_runs(id) ON DELETE CASCADE,
    pdf_path   TEXT,
    emailed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
