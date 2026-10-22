import { pool } from './pool.js';

// callers pass runId from worker or one already loaded through workspace

// everything about run that report needs
// including previous audited run's headline for comparisons
export async function getReportContext(runId) {
    const { rows } = await pool.query(
        `SELECT r.id, r.engine, r.model, r.samples_per_query, r.stats, r.created_at, r.finished_at,
                c.id AS category_id, c.name AS category_name, c.workspace_id, c.report_recipients,
                b.name AS brand_name,
                prev.stats -> 'headline' AS prev_headline, prev.created_at AS prev_created_at
         FROM harvest_runs r
         JOIN categories c ON c.id = r.category_id
         JOIN brands b ON b.id = c.brand_id
         LEFT JOIN harvest_runs prev ON prev.id = (r.stats -> 'shifts' ->> 'previous_run_id')::uuid
         WHERE r.id = $1`,
        [runId]
    );
    return rows[0];
}

// store (or replace) run's pdf
// email fields reset because this version hasnt been sent
export async function saveReport(runId, pdf) {
    await pool.query(
        `INSERT INTO reports (run_id, pdf) VALUES ($1, $2)
         ON CONFLICT (run_id) DO UPDATE SET pdf = EXCLUDED.pdf, recipients = '{}', emailed_at = NULL,
            email_error = NULL, updated_at = now()`,
        [runId, pdf]
    );
}

export async function markEmailed(runId, { recipients, error = null }) {
    await pool.query(
        `UPDATE reports SET recipients = $2, email_error = $3, emailed_at = CASE WHEN $3::text IS NULL THEN now() END
         WHERE run_id = $1`,
        [runId, recipients, error]
    );
}

export async function getReport(runId) {
    const { rows } = await pool.query(
        'SELECT run_id, pdf, recipients, emailed_at, email_error, created_at, updated_at FROM reports WHERE run_id = $1',
        [runId]
    );
    return rows[0];
}
