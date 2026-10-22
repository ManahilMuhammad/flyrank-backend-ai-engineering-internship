import { pool } from './pool.js';

// every query takes workspaceId and filters on it, same as brands

const COLUMNS = `c.id, c.workspace_id, c.brand_id, c.name, c.description, c.weekly_harvest, c.created_at,
    (SELECT count(*)::int FROM queries q WHERE q.category_id = c.id AND q.active) AS active_query_count`;

export async function createCategory(workspaceId, { brand_id, name, description, weekly_harvest = false }) {
    const { rows } = await pool.query(
        `INSERT INTO categories (workspace_id, brand_id, name, description, weekly_harvest)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [workspaceId, brand_id, name, description ?? null, weekly_harvest]
    );
    return getCategory(workspaceId, rows[0].id);
}

export async function listCategories(workspaceId) {
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM categories c WHERE c.workspace_id = $1 ORDER BY c.created_at`,
        [workspaceId]
    );
    return rows;
}

export async function getCategory(workspaceId, categoryId) {
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM categories c WHERE c.workspace_id = $1 AND c.id = $2`,
        [workspaceId, categoryId]
    );
    return rows[0];
}

// only the fields present in `fields` are changed (brand_id is fixed once created)
export async function updateCategory(workspaceId, categoryId, fields) {
    const allowed = ['name', 'description', 'weekly_harvest'];
    const sets = [];
    const values = [workspaceId, categoryId];

    for (const key of allowed) {
        if (fields[key] !== undefined) {
            values.push(fields[key]);
            sets.push(`${key} = $${values.length}`);
        }
    }

    const { rowCount } = await pool.query(
        `UPDATE categories SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2`,
        values
    );
    return rowCount ? getCategory(workspaceId, categoryId) : undefined;
}

// cascades to queries and harvest runs
export async function deleteCategory(workspaceId, categoryId) {
    const { rowCount } = await pool.query(
        'DELETE FROM categories WHERE workspace_id = $1 AND id = $2',
        [workspaceId, categoryId]
    );
    return rowCount > 0;
}
