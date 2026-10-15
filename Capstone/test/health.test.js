import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

const app = createApp();

beforeAll(async () => {
    await migrate();
});

afterAll(async () => {
    await pool.end();
});

describe('general routes', () => {
    it('GET / returns API info', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Priors API');
    });

    it('GET /health reports a connected database and the latest migration', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', database: 'connected', migration: '003_harvest.sql' });
    });

    it('unknown routes return 404 JSON', async () => {
        const res = await request(app).get('/nope');
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/);
    });
});

describe('schema', () => {
    it('creates every table in the data model', async () => {
        const { rows } = await pool.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
        );
        const tables = rows.map(r => r.table_name);
        for (const t of [
            'workspaces', 'workspace_members', 'brands', 'categories', 'queries',
            'harvest_runs', 'answers', 'sources', 'url_resolutions', 'citations',
            'source_snapshots', 'standings', 'source_scores', 'shift_events', 'reports'
        ]) {
            expect(tables).toContain(t);
        }
    });
});
