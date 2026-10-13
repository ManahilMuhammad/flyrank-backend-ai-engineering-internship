import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, withTransaction } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// apply every sql file not applied yet in migrations in filename order
export async function migrate() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    const { rows } = await pool.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(r => r.name));

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const pending = files.filter(f => !applied.has(f));

    for (const file of pending) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
        await withTransaction(async client => {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        });
        console.log(`Applied migration ${file}`);
    }

    if (pending.length === 0) console.log('Database is up to date');
}

// run directly with npm run migrate
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    migrate()
        .catch(err => {
            console.error('Migration failed: ', err.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}
