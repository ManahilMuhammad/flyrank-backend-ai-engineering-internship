import { pool, withTransaction } from './pool.js';

// queries have no workspace_id of their own; callers pass a categoryId that was already
// loaded through the workspace (requireCategory), and every statement filters on it

const COLUMNS = 'id, category_id, text, intent, variant_of, active, origin, generation_model, created_at';

export async function listQueries(categoryId, { active } = {}) {
    const values = [categoryId];
    let filter = '';
    if (active !== undefined) {
        values.push(active);
        filter = 'AND active = $2';
    }
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM queries WHERE category_id = $1 ${filter} ORDER BY created_at, id`,
        values
    );
    return rows;
}

export async function listQueryTexts(categoryId) {
    const { rows } = await pool.query('SELECT text FROM queries WHERE category_id = $1', [categoryId]);
    return rows.map(r => r.text);
}

// save generator output: seeds first, then their paraphrases pointing at the seed's id.
// exact duplicates of existing queries are skipped (ON CONFLICT) rather than failing the batch
export async function saveGeneratedQueries(categoryId, queries, model) {
    return withTransaction(async client => {
        const seedIds = new Map(); // generator group index -> saved seed id
        const saved = [];

        const ordered = [...queries.filter(q => q.is_seed), ...queries.filter(q => !q.is_seed)];
        for (const q of ordered) {
            const { rows } = await client.query(
                `INSERT INTO queries (category_id, text, intent, variant_of, origin, generation_model)
                 VALUES ($1, $2, $3, $4, 'generated', $5)
                 ON CONFLICT (category_id, text) DO NOTHING
                 RETURNING ${COLUMNS}`,
                [categoryId, q.text, q.intent, q.is_seed ? null : seedIds.get(q.group) ?? null, model]
            );
            if (!rows[0]) continue;
            if (q.is_seed) seedIds.set(q.group, rows[0].id);
            saved.push(rows[0]);
        }

        return saved;
    });
}

// add queries by hand; returns only the ones that were new
export async function addManualQueries(categoryId, items) {
    return withTransaction(async client => {
        const saved = [];
        for (const { text, intent } of items) {
            const { rows } = await client.query(
                `INSERT INTO queries (category_id, text, intent, origin)
                 VALUES ($1, $2, $3, 'manual')
                 ON CONFLICT (category_id, text) DO NOTHING
                 RETURNING ${COLUMNS}`,
                [categoryId, text, intent ?? null]
            );
            if (rows[0]) saved.push(rows[0]);
        }
        return saved;
    });
}

export async function updateQuery(categoryId, queryId, fields) {
    const allowed = ['text', 'intent', 'active'];
    const sets = [];
    const values = [categoryId, queryId];

    for (const key of allowed) {
        if (fields[key] !== undefined) {
            values.push(fields[key]);
            sets.push(`${key} = $${values.length}`);
        }
    }

    const { rows } = await pool.query(
        `UPDATE queries SET ${sets.join(', ')} WHERE category_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        values
    );
    return rows[0];
}

export async function deleteQuery(categoryId, queryId) {
    const { rowCount } = await pool.query(
        'DELETE FROM queries WHERE category_id = $1 AND id = $2',
        [categoryId, queryId]
    );
    return rowCount > 0;
}
