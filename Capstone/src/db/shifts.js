import { pool, withTransaction } from './pool.js';

// callers pass runId from  worker or categoryId/runId already loaded through workspace

// run plus category's most recent earlier run that got as far as an audit
export async function getRunWithPrevious(runId) {
    const { rows } = await pool.query(
        `SELECT r.id, r.category_id, r.stats,
                prev.id AS prev_id, prev.stats AS prev_stats
         FROM harvest_runs r
         LEFT JOIN LATERAL (
            SELECT p.id, p.stats FROM harvest_runs p
            WHERE p.category_id = r.category_id AND p.id <> r.id AND p.status = 'completed'
              AND p.stats ? 'headline' AND p.created_at < r.created_at
            ORDER BY p.created_at DESC LIMIT 1
         ) prev ON true
         WHERE r.id = $1`,
        [runId]
    );
    return rows[0];
}

// what diff needs about each scored source of run
export async function listRunSourceState(runId) {
    const { rows } = await pool.query(
        `SELECT ss.source_id, s.url_canonical AS url, s.domain, ss.rank, ss.influence,
                ss.citation_rate, ss.citation_count, st.stance, st.is_stale, st.stale_reason, st.evidence_passage
         FROM source_scores ss
         JOIN sources s ON s.id = ss.source_id
         LEFT JOIN standings st ON st.id = ss.standing_id
         WHERE ss.run_id = $1`,
        [runId]
    );
    return rows;
}

// replace run's events (re-auditing run re-diffs it)
export async function replaceShiftEvents(run, prevRunId, events, summary) {
    await withTransaction(async client => {
        await client.query('DELETE FROM shift_events WHERE run_id = $1', [run.id]);
        for (const e of events) {
            await client.query(
                `INSERT INTO shift_events (category_id, run_id, prev_run_id, type, source_id, delta, payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [run.category_id, run.id, prevRunId, e.type, e.sourceId ?? null, e.delta, e.payload]
            );
        }
        await client.query(
            `UPDATE harvest_runs SET stats = stats || jsonb_build_object('shifts', $2::jsonb) WHERE id = $1`,
            [run.id, JSON.stringify(summary)]
        );
    });
}

const EVENT_COLUMNS = `e.id, e.run_id, e.prev_run_id, e.type, e.source_id, s.url_canonical AS url, s.domain,
    e.delta, e.payload, e.created_at`;

export async function listRunShifts(runId) {
    const { rows } = await pool.query(
        `SELECT ${EVENT_COLUMNS}
         FROM shift_events e LEFT JOIN sources s ON s.id = e.source_id
         WHERE e.run_id = $1
         ORDER BY e.type, abs(e.delta) DESC NULLS LAST`,
        [runId]
    );
    return rows;
}

// category's alert feed
// newest runs first
export async function listCategoryShifts(categoryId, { type, limit }) {
    const values = [categoryId, limit];
    let filter = '';
    if (type) {
        values.push(type);
        filter = `AND e.type = $${values.length}`;
    }
    const { rows } = await pool.query(
        `SELECT ${EVENT_COLUMNS}
         FROM shift_events e LEFT JOIN sources s ON s.id = e.source_id
         WHERE e.category_id = $1 ${filter}
         ORDER BY e.created_at DESC, e.type, abs(e.delta) DESC NULLS LAST
         LIMIT $2`,
        values
    );
    return rows;
}

// categories weekly cron should re-harvest
export async function listScheduledCategories() {
    const { rows } = await pool.query(
        `SELECT c.id, c.name FROM categories c
         WHERE c.weekly_harvest AND EXISTS (SELECT 1 FROM queries q WHERE q.category_id = c.id AND q.active)
         ORDER BY c.created_at`
    );
    return rows;
}
