import { pool } from './pool.js';

// standings keyed on (snapshot, brand, prompt version) so unchanged page never classified twice
// callers pass runId from worker or one already loaded through workspace

// the brand a run audits for with what audit needs
export async function getRunBrand(runId) {
    const { rows } = await pool.query(
        `SELECT b.id, b.name, b.aliases, b.domains, b.fact_sheet
         FROM harvest_runs r JOIN categories c ON c.id = r.category_id JOIN brands b ON b.id = c.brand_id
         WHERE r.id = $1`,
        [runId]
    );
    return rows[0];
}

// run's top sources with page text and any standing already made for snapshot
export async function listSourcesToAudit(runId, brandId, promptVersion, limit) {
    const { rows } = await pool.query(
        `SELECT ss.source_id, ss.rank, s.url_canonical AS url, s.domain, s.title,
                sn.id AS snapshot_id, sn.fetch_status, sn.extracted_text,
                st.id AS standing_id
         FROM source_scores ss
         JOIN sources s ON s.id = ss.source_id
         LEFT JOIN source_snapshots sn ON sn.id = ss.snapshot_id
         LEFT JOIN standings st ON st.snapshot_id = sn.id AND st.brand_id = $2 AND st.prompt_version = $3
         WHERE ss.run_id = $1 AND ss.rank <= $4
         ORDER BY ss.rank`,
        [runId, brandId, promptVersion, limit]
    );
    return rows;
}

// returns standing id (existing one if another worker saved same verdict first)
export async function saveStanding(s) {
    const { rows } = await pool.query(
        `INSERT INTO standings (snapshot_id, brand_id, stance, is_stale, stale_reason, evidence_passage,
                                confidence, model, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (snapshot_id, brand_id, prompt_version) DO NOTHING
         RETURNING id`,
        [s.snapshotId, s.brandId, s.stance, s.isStale, s.staleReason, s.evidence, s.confidence, s.model, s.promptVersion]
    );
    if (rows[0]) return rows[0].id;
    const existing = await pool.query(
        'SELECT id FROM standings WHERE snapshot_id = $1 AND brand_id = $2 AND prompt_version = $3',
        [s.snapshotId, s.brandId, s.promptVersion]
    );
    return existing.rows[0].id;
}

// point run's score at verdict or record why there isnt one
export async function linkStanding(runId, sourceId, { standingId = null, note = null }) {
    await pool.query(
        'UPDATE source_scores SET standing_id = $3, audit_note = $4 WHERE run_id = $1 AND source_id = $2',
        [runId, sourceId, standingId, note]
    );
}

export async function saveAuditStats(runId, auditStats) {
    await pool.query(
        `UPDATE harvest_runs SET stats = stats || jsonb_build_object('audit', $2::jsonb) WHERE id = $1`,
        [runId, JSON.stringify(auditStats)]
    );
}

// run's audited sources in influence order
export async function listRunStandings(runId, { stance, stale, limit }) {
    const values = [runId, limit];
    const filters = [];
    if (stance) {
        values.push(stance);
        filters.push(`st.stance = $${values.length}`);
    }
    if (stale !== undefined) {
        values.push(stale);
        filters.push(`st.is_stale = $${values.length}`);
    }
    const { rows } = await pool.query(
        `SELECT ss.rank, s.id AS source_id, s.url_canonical AS url, s.domain, s.source_type, s.title,
                ss.influence, sn.fetch_status, ss.audit_note,
                st.stance, st.is_stale, st.stale_reason, st.evidence_passage, st.confidence,
                st.model, st.prompt_version, st.created_at AS audited_at
         FROM source_scores ss
         JOIN sources s ON s.id = ss.source_id
         LEFT JOIN source_snapshots sn ON sn.id = ss.snapshot_id
         LEFT JOIN standings st ON st.id = ss.standing_id
         WHERE ss.run_id = $1 AND ss.rank <= $2 ${filters.map(f => `AND ${f}`).join(' ')}
         ORDER BY ss.rank`,
        values
    );
    return rows;
}
