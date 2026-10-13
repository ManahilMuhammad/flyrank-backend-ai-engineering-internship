import pg from 'pg';
import { env } from '../config.js';

export const pool = new pg.Pool({ connectionString: env.databaseUrl });

pool.on('error', err => {
    console.error('Idle database client error: ', err.code || err.message);
});

// run function inside transaction; roll back if error
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
