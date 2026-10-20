import { pool, withTransaction } from './pool.js';

// callers pass a runId already loaded through the workspace (requireRun) or from worker

// rank every source cited in a run by influence and store in source_scores
// influence = sum of source's support_weight / all answers in run (including ungrounded ones)
// replaces run's scores
export async function scoreRun(runId) {
    return withTransaction(async client => {
        await client.query('DELETE FROM source_scores WHERE run_id = $1', [runId]);
        const { rowCount } = await client.query(
            `WITH n AS (SELECT count(*)::real AS answers FROM answers WHERE run_id = $1),
             agg AS (
                SELECT c.source_id,
                       sum(c.support_weight) AS weight,
                       count(*)::int AS citations,
                       count(DISTINCT a.query_id)::int AS queries
                FROM citations c JOIN answers a ON a.id = c.answer_id
                WHERE a.run_id = $1
                GROUP BY c.source_id
             )
             INSERT INTO source_scores (run_id, source_id, influence, citation_count, query_count, citation_rate, rank)
             SELECT $1, agg.source_id, agg.weight / n.answers, agg.citations, agg.queries, agg.citations / n.answers,
                    row_number() OVER (ORDER BY agg.weight DESC, agg.citations DESC, agg.source_id)
             FROM agg, n`,
            [runId]
        );
        return rowCount;
    });
}

export async function listTopSources(runId, limit) {
    const { rows } = await pool.query(
        `SELECT ss.rank, s.id AS source_id, s.url_canonical AS url, s.domain, s.source_type, s.title,
                ss.influence, ss.citation_rate, ss.citation_count, ss.query_count,
                -- null until the source has been fetched for this run
                sn.fetch_status, sn.checked_at AS fetch_checked_at, sn.error AS fetch_error
         FROM source_scores ss
         JOIN sources s ON s.id = ss.source_id
         LEFT JOIN source_snapshots sn ON sn.id = ss.snapshot_id
         WHERE ss.run_id = $1
         ORDER BY ss.rank
         LIMIT $2`,
        [runId, limit]
    );
    return rows;
}

// same numbers rolled up per site
// influence adds up, citation_rate counts each answer once
export async function listTopDomains(runId, limit) {
    const { rows } = await pool.query(
        `WITH n AS (SELECT count(*)::real AS answers FROM answers WHERE run_id = $1),
         per_domain AS (
            SELECT s.domain,
                   sum(c.support_weight) AS weight,
                   count(DISTINCT c.answer_id)::int AS citations,
                   count(DISTINCT a.query_id)::int AS queries,
                   count(DISTINCT s.id)::int AS pages
            FROM citations c
            JOIN answers a ON a.id = c.answer_id
            JOIN sources s ON s.id = c.source_id
            WHERE a.run_id = $1
            GROUP BY s.domain
         )
         SELECT row_number() OVER (ORDER BY weight DESC, citations DESC, domain)::int AS rank,
                domain, pages, weight / n.answers AS influence, citations / n.answers AS citation_rate,
                citations AS citation_count, queries AS query_count
         FROM per_domain, n
         ORDER BY rank
         LIMIT $2`,
        [runId, limit]
    );
    return rows;
}

// pairs among top `limit` sources cited in same answer at least minTogether times
// jaccard = together / answers citing either so two pages that always appear together score 1
export async function listCoCitations(runId, limit, minTogether) {
    const { rows } = await pool.query(
        `WITH top AS (
            SELECT source_id, citation_count FROM source_scores WHERE run_id = $1 AND rank <= $2
         ),
         cited AS (
            SELECT c.answer_id, c.source_id
            FROM citations c JOIN answers a ON a.id = c.answer_id
            WHERE a.run_id = $1 AND c.source_id IN (SELECT source_id FROM top)
         ),
         pairs AS (
            SELECT x.source_id AS source_a, y.source_id AS source_b, count(*)::int AS together
            FROM cited x JOIN cited y ON y.answer_id = x.answer_id AND x.source_id < y.source_id
            GROUP BY 1, 2
            HAVING count(*) >= $3
         )
         SELECT p.source_a, p.source_b, p.together,
                p.together::real / (ta.citation_count + tb.citation_count - p.together) AS jaccard
         FROM pairs p
         JOIN top ta ON ta.source_id = p.source_a
         JOIN top tb ON tb.source_id = p.source_b
         ORDER BY p.together DESC, jaccard DESC, p.source_a, p.source_b`,
        [runId, limit, minTogether]
    );
    return rows;
}
