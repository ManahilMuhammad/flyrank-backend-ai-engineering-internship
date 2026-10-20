import { pool } from './pool.js';

// every query takes workspaceId and filters on it 
// so brand id from another workspace not found

const COLUMNS = 'id, workspace_id, name, aliases, domains, fact_sheet, created_at, updated_at';

export async function createBrand(workspaceId, { name, aliases, domains = [], fact_sheet }) {
    const { rows } = await pool.query(
        `INSERT INTO brands (workspace_id, name, aliases, domains, fact_sheet)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [workspaceId, name, aliases, domains, fact_sheet]
    );
    return rows[0];
}

export async function listBrands(workspaceId) {
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM brands WHERE workspace_id = $1 ORDER BY created_at`,
        [workspaceId]
    );
    return rows;
}

export async function getBrand(workspaceId, brandId) {
    const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM brands WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, brandId]
    );
    return rows[0];
}

// only the fields present in fields changed
export async function updateBrand(workspaceId, brandId, fields) {
    const allowed = ['name', 'aliases', 'domains', 'fact_sheet'];
    const sets = [];
    const values = [workspaceId, brandId];

    for (const key of allowed) {
        if (fields[key] !== undefined) {
            values.push(fields[key]);
            sets.push(`${key} = $${values.length}`);
        }
    }

    const { rows } = await pool.query(
        `UPDATE brands SET ${sets.join(', ')}, updated_at = now()
         WHERE workspace_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        values
    );
    return rows[0];
}

// true if row deleted
export async function deleteBrand(workspaceId, brandId) {
    const { rowCount } = await pool.query(
        'DELETE FROM brands WHERE workspace_id = $1 AND id = $2',
        [workspaceId, brandId]
    );
    return rowCount > 0;
}
