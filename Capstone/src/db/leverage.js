import { pool, withTransaction } from './pool.js';

// callers pass runId from worker or one already loaded through workspace

// every scored source of run with its verdict (if any) most influential first
export async function listScoredSources(runId) {
    const { rows } = await pool.query(
        `SELECT ss.source_id, ss.rank, ss.influence, s.domain, st.stance, st.is_stale
         FROM source_scores ss
         JOIN sources s ON s.id = ss.source_id
         LEFT JOIN standings st ON st.id = ss.standing_id
         WHERE ss.run_id = $1
         ORDER BY ss.rank`,
        [runId]
    );
    return rows;
}

export async function saveLeverage(runId, items) {
    await withTransaction(async client => {
        for (const item of items) {
            await client.query(
                `UPDATE source_scores SET deficit = $3, leverage = $4, leverage_rank = $5, action = $6
                 WHERE run_id = $1 AND source_id = $2`,
                [runId, item.sourceId, item.deficit, item.leverage, item.leverageRank, item.action]
            );
        }
    });
}

// answer level counts for headline
// owned = cites page on one of brand's domains (or subdomain)
export async function countAnswers(runId, brandDomains) {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE a.brand_mentioned)::int AS mentioned,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM citations c WHERE c.answer_id = a.id))::int AS grounded,
                count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM citations c JOIN sources s ON s.id = c.source_id
                    WHERE c.answer_id = a.id
                      AND EXISTS (SELECT 1 FROM unnest($2::text[]) d WHERE s.domain = d OR s.domain LIKE '%.' || d)
                ))::int AS citing_owned
         FROM answers a
         WHERE a.run_id = $1`,
        [runId, brandDomains]
    );
    return rows[0];
}

export async function saveHeadline(runId, headline) {
    await pool.query(
        `UPDATE harvest_runs SET stats = stats || jsonb_build_object('headline', $2::jsonb) WHERE id = $1`,
        [runId, JSON.stringify(headline)]
    );
}

const ROW_COLUMNS = `ss.rank, ss.leverage_rank, s.id AS source_id, s.url_canonical AS url, s.domain, s.source_type, s.title,
    ss.influence, ss.citation_rate, ss.query_count, ss.deficit, ss.leverage, ss.action,
    st.stance, st.is_stale, st.stale_reason, st.evidence_passage, st.confidence,
    sn.fetch_status, ss.audit_note`;
const ROW_JOINS = `FROM source_scores ss
    JOIN sources s ON s.id = ss.source_id
    LEFT JOIN standings st ON st.id = ss.standing_id
    LEFT JOIN source_snapshots sn ON sn.id = ss.snapshot_id`;

// action list: sources with something to fix, highest leverage first
export async function listActions(runId, limit) {
    const { rows } = await pool.query(
        `SELECT ${ROW_COLUMNS} ${ROW_JOINS}
         WHERE ss.run_id = $1 AND ss.leverage_rank IS NOT NULL
         ORDER BY ss.leverage_rank
         LIMIT $2`,
        [runId, limit]
    );
    return rows;
}

// top sources with no verdict (blocked, failed, rejected) most influential first
// kept visible so big source that couldnt be read doesnt drop out of list
export async function listUnaudited(runId, topN) {
    const { rows } = await pool.query(
        `SELECT ${ROW_COLUMNS} ${ROW_JOINS}
         WHERE ss.run_id = $1 AND ss.rank <= $2 AND ss.standing_id IS NULL
         ORDER BY ss.rank`,
        [runId, topN]
    );
    return rows;
}
