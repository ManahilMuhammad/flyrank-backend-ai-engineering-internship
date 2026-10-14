import { pool, withTransaction } from './pool.js';

// create workspace and make creator the owner
export async function createWorkspace(userId, name) {
    return withTransaction(async client => {
        const { rows } = await client.query(
            'INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name, created_at',
            [name]
        );
        await client.query(
            `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
            [rows[0].id, userId]
        );
        return { ...rows[0], role: 'owner' };
    });
}

// only workspaces the user is a member of
export async function listWorkspacesForUser(userId) {
    const { rows } = await pool.query(
        `SELECT w.id, w.name, w.created_at, m.role
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = $1
         ORDER BY w.created_at`,
        [userId]
    );
    return rows;
}

// workspace plus user's role in it or undefined if not a member
export async function getWorkspaceForUser(workspaceId, userId) {
    const { rows } = await pool.query(
        `SELECT w.id, w.name, w.created_at, m.role
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE w.id = $1 AND m.user_id = $2`,
        [workspaceId, userId]
    );
    return rows[0];
}

export async function renameWorkspace(workspaceId, name) {
    const { rows } = await pool.query(
        'UPDATE workspaces SET name = $1 WHERE id = $2 RETURNING id, name, created_at',
        [name, workspaceId]
    );
    return rows[0];
}

// cascades to members, brands, categories etc
export async function deleteWorkspace(workspaceId) {
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
}
