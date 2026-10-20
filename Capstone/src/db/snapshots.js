import { pool } from './pool.js';

// sources and snapshots global
// callers pass runId from worker or one already loaded through workspace

// run's top sources with what already known
export async function listSourcesToFetch(runId, limit) {
    const { rows } = await pool.query(
        `SELECT s.id, s.url_canonical AS url, s.domain, s.title,
                latest.id AS latest_id, latest.fetch_status AS latest_status, latest.checked_at AS latest_checked_at,
                ok.id AS ok_id, ok.etag AS ok_etag, ok.last_modified AS ok_last_modified
         FROM source_scores ss
         JOIN sources s ON s.id = ss.source_id
         LEFT JOIN LATERAL (
            SELECT id, fetch_status, checked_at FROM source_snapshots
            WHERE source_id = s.id ORDER BY checked_at DESC LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
            SELECT id, etag, last_modified FROM source_snapshots
            WHERE source_id = s.id AND fetch_status = 'ok' ORDER BY checked_at DESC LIMIT 1
         ) ok ON true
         WHERE ss.run_id = $1 AND ss.rank <= $2
         ORDER BY ss.rank`,
        [runId, limit]
    );
    return rows;
}

// page still says same thing: move to front without storing anything new
export async function touchSnapshot(snapshotId, { httpStatus, etag, lastModified } = {}) {
    await pool.query(
        `UPDATE source_snapshots SET checked_at = now(), http_status = COALESCE($2, http_status),
                etag = COALESCE($3, etag), last_modified = COALESCE($4, last_modified)
         WHERE id = $1`,
        [snapshotId, httpStatus ?? null, etag ?? null, lastModified ?? null]
    );
}

// store extracted text
// returns { id, inserted }
export async function saveTextSnapshot(sourceId, { hash, text, httpStatus, finalUrl, etag, lastModified }) {
    const { rows } = await pool.query(
        `INSERT INTO source_snapshots
            (source_id, content_hash, extracted_text, fetch_status, http_status, final_url, etag, last_modified)
         VALUES ($1, $2, $3, 'ok', $4, $5, $6, $7)
         ON CONFLICT (source_id, content_hash) DO UPDATE SET
            checked_at = now(), http_status = EXCLUDED.http_status, final_url = EXCLUDED.final_url,
            etag = EXCLUDED.etag, last_modified = EXCLUDED.last_modified
         RETURNING id, (xmax = 0) AS inserted`, // xmax is 0 only on fresh insert
        [sourceId, hash, text, httpStatus, finalUrl, etag ?? null, lastModified ?? null]
    );
    return rows[0];
}

// failed or skipped attempt recorded so the page's current state visible
export async function saveFailedSnapshot(sourceId, { status, httpStatus, finalUrl, error }) {
    const { rows } = await pool.query(
        `INSERT INTO source_snapshots (source_id, fetch_status, http_status, final_url, error)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [sourceId, status, httpStatus ?? null, finalUrl ?? null, error ?? null]
    );
    return rows[0].id;
}

export async function linkSnapshot(runId, sourceId, snapshotId) {
    await pool.query(
        'UPDATE source_scores SET snapshot_id = $3 WHERE run_id = $1 AND source_id = $2',
        [runId, sourceId, snapshotId]
    );
}

// fill in page's own title when available
export async function fillSourceTitle(sourceId, title) {
    await pool.query('UPDATE sources SET title = $2 WHERE id = $1 AND title IS NULL', [sourceId, title]);
}

// fetch stats live next to harvest stats on run
export async function saveFetchStats(runId, fetchStats) {
    await pool.query(
        `UPDATE harvest_runs SET stats = stats || jsonb_build_object('fetch', $2::jsonb) WHERE id = $1`,
        [runId, JSON.stringify(fetchStats)]
    );
}
