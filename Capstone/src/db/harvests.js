import { pool } from './pool.js';

// route functions take categoryId already loaded through workspace (requireCategory)
// worker functions take only runId: job comes from own queue, not a request

const COLUMNS = `id, category_id, engine, model, samples_per_query, status, stats, error,
    created_at, started_at, finished_at`;

export async function createRun(categoryId, { model, samplesPerQuery }) {
    const { rows } = await pool.query(
        `INSERT INTO harvest_runs (category_id, model, samples_per_query)
         VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [categoryId, model, samplesPerQuery]
    );
    return rows[0];
}

export async function listRuns(categoryId) {
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM harvest_runs WHERE category_id = $1 ORDER BY created_at DESC`,
        [categoryId]
    );
    return rows;
}

export async function getRun(categoryId, runId) {
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM harvest_runs WHERE category_id = $1 AND id = $2`,
        [categoryId, runId]
    );
    return rows[0];
}

// answers with sources each was grounded in (heaviest first)
export async function listAnswers(runId, { queryId } = {}) {
    const values = [runId];
    let filter = '';
    if (queryId) {
        values.push(queryId);
        filter = 'AND a.query_id = $2';
    }
    const { rows } = await pool.query(
        `SELECT a.id, a.query_id, q.text AS query_text, a.sample_n, a.answer_text, a.brand_mentioned,
                a.search_queries, a.created_at,
                COALESCE(json_agg(json_build_object(
                    'source_id', s.id, 'url', s.url_canonical, 'domain', s.domain,
                    'support_weight', c.support_weight, 'chunk_index', c.chunk_index
                ) ORDER BY c.support_weight DESC, c.chunk_index) FILTER (WHERE s.id IS NOT NULL), '[]') AS citations
         FROM answers a
         JOIN queries q ON q.id = a.query_id
         LEFT JOIN citations c ON c.answer_id = a.id
         LEFT JOIN sources s ON s.id = c.source_id
         WHERE a.run_id = $1 ${filter}
         GROUP BY a.id, q.id
         ORDER BY q.created_at, q.id, a.sample_n`,
        values
    );
    return rows;
}

// --> worker side

// run plus what worker needs to execute it
export async function getRunForWorker(runId) {
    const { rows } = await pool.query(
        `SELECT r.id, r.category_id, r.samples_per_query, r.status, r.started_at,
                b.name AS brand_name, b.aliases AS brand_aliases
         FROM harvest_runs r
         JOIN categories c ON c.id = r.category_id
         JOIN brands b ON b.id = c.brand_id
         WHERE r.id = $1`,
        [runId]
    );
    return rows[0];
}

export async function listActiveQueries(categoryId) {
    const { rows } = await pool.query(
        'SELECT id, text FROM queries WHERE category_id = $1 AND active ORDER BY created_at, id',
        [categoryId]
    );
    return rows;
}

// (query, sample) pairs already answered
// so retried job resumes instead of starting over
export async function listDoneSamples(runId) {
    const { rows } = await pool.query('SELECT query_id, sample_n FROM answers WHERE run_id = $1', [runId]);
    return new Set(rows.map(r => `${r.query_id}:${r.sample_n}`));
}

// queued -> running
// also accepts running so retried job can pick up where it stopped
export async function markRunning(runId) {
    const { rows } = await pool.query(
        `UPDATE harvest_runs SET status = 'running', started_at = COALESCE(started_at, now()), error = NULL
         WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
        [runId]
    );
    return rows.length > 0;
}

export async function updateStats(runId, stats) {
    await pool.query('UPDATE harvest_runs SET stats = $2 WHERE id = $1', [runId, stats]);
}

export async function finishRun(runId, { status, stats, error = null }) {
    await pool.query(
        `UPDATE harvest_runs SET status = $2, stats = COALESCE($3, stats), error = $4, finished_at = now()
         WHERE id = $1`,
        [runId, status, stats ?? null, error]
    );
}

// answer, its sources and citations saved together or not at all
// returns false if already saved by earlier attempt
export async function saveAnswer(client, { runId, queryId, sampleN, text, brandMentioned, searchQueries, citations }) {
    const { rows } = await client.query(
        `INSERT INTO answers (run_id, query_id, sample_n, answer_text, brand_mentioned, search_queries)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_id, query_id, sample_n) DO NOTHING
         RETURNING id`,
        [runId, queryId, sampleN, text, brandMentioned, searchQueries]
    );
    if (!rows[0]) return false;
    const answerId = rows[0].id;

    for (const c of citations) {
        // sources shared across workspaces, keep first title seen
        const { rows: [source] } = await client.query(
            `INSERT INTO sources (url_canonical, domain, source_type, title) VALUES ($1, $2, $3, $4)
             ON CONFLICT (url_canonical) DO UPDATE SET title = COALESCE(sources.title, EXCLUDED.title)
             RETURNING id`,
            [c.url, c.domain, c.sourceType, c.title]
        );
        await client.query(
            `INSERT INTO citations (answer_id, source_id, support_weight, chunk_index) VALUES ($1, $2, $3, $4)`,
            [answerId, source.id, c.weight, c.chunkIndex]
        );
    }
    return true;
}

// totals computed from what was stored
// they stay right across retries
export async function computeRunTotals(runId, categoryId) {
    const { rows: [totals] } = await pool.query(
        `SELECT
            (SELECT count(*)::int FROM answers WHERE run_id = $1) AS answers,
            (SELECT count(*)::int FROM answers WHERE run_id = $1 AND brand_mentioned) AS brand_mentions,
            (SELECT count(*)::int FROM answers a WHERE a.run_id = $1
                AND NOT EXISTS (SELECT 1 FROM citations c WHERE c.answer_id = a.id)) AS ungrounded_answers,
            (SELECT count(*)::int FROM citations c JOIN answers a ON a.id = c.answer_id WHERE a.run_id = $1) AS citations,
            (SELECT count(DISTINCT c.source_id)::int FROM citations c JOIN answers a ON a.id = c.answer_id
                WHERE a.run_id = $1) AS unique_sources,
            (SELECT count(DISTINCT s.domain)::int FROM citations c JOIN answers a ON a.id = c.answer_id
                JOIN sources s ON s.id = c.source_id WHERE a.run_id = $1) AS unique_domains,
            -- cited now but never in an earlier run of this category
            (SELECT count(DISTINCT c.source_id)::int FROM citations c JOIN answers a ON a.id = c.answer_id
                WHERE a.run_id = $1 AND NOT EXISTS (
                    SELECT 1 FROM citations c2
                    JOIN answers a2 ON a2.id = c2.answer_id
                    JOIN harvest_runs r2 ON r2.id = a2.run_id
                    WHERE c2.source_id = c.source_id AND r2.category_id = $2 AND r2.id <> $1
                      AND r2.created_at < (SELECT created_at FROM harvest_runs WHERE id = $1))) AS new_sources`,
        [runId, categoryId]
    );
    return totals;
}
