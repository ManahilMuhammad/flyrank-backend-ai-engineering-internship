import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// replace supabase with two fake users so tests dont need real accounts / network
const USERS = {
    'token-a': { id: '00000000-0000-4000-8000-00000000000a', email: 'a@test.local' },
    'token-b': { id: '00000000-0000-4000-8000-00000000000b', email: 'b@test.local' }
};
vi.mock('../src/lib/supabase.js', () => ({
    getUserFromToken: async token => USERS[token] ?? null,
    signUp: async () => { throw new Error('not used in tests'); },
    signIn: async () => { throw new Error('not used in tests'); }
}));

const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asA = { Authorization: 'Bearer token-a' };
const asB = { Authorization: 'Bearer token-b' };

let workspaceA; // owned by user A
let workspaceB; // owned by user B
let brandA;     // in workspace A

beforeAll(async () => {
    await migrate();
});

afterAll(async () => {
    // cascades to members and brands
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-a'].id, USERS['token-b'].id]]
    );
    await pool.end();
});

describe('authentication', () => {
    it('rejects requests with no token', async () => {
        const res = await request(app).get('/workspaces');
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Access token required');
    });

    it('rejects a malformed Authorization header', async () => {
        const res = await request(app).get('/workspaces').set({ Authorization: 'token-a' });
        expect(res.status).toBe(401);
    });

    it('rejects an invalid token', async () => {
        const res = await request(app).get('/workspaces').set({ Authorization: 'Bearer nope' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid or expired token');
    });

    it('GET /auth/me returns the token owner', async () => {
        const res = await request(app).get('/auth/me').set(asA);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(USERS['token-a']);
    });
});

describe('workspaces', () => {
    it('creates a workspace owned by the caller', async () => {
        const res = await request(app).post('/workspaces').set(asA).send({ name: '  FlyRank demo  ' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: 'FlyRank demo', role: 'owner' }); // name trimmed
        workspaceA = res.body;

        const resB = await request(app).post('/workspaces').set(asB).send({ name: 'Other tenant' });
        workspaceB = resB.body;
    });

    it('validates the body', async () => {
        const res = await request(app).post('/workspaces').set(asA).send({ name: '' });
        expect(res.status).toBe(400);
        expect(res.body.details[0].path).toBe('name');

        const extra = await request(app).post('/workspaces').set(asA).send({ name: 'x', owner: 'someone' });
        expect(extra.status).toBe(400); // unknown fields rejected
    });

    it('lists only the caller\'s workspaces', async () => {
        const resA = await request(app).get('/workspaces').set(asA);
        const resB = await request(app).get('/workspaces').set(asB);
        expect(resA.body.map(w => w.id)).toContain(workspaceA.id);
        expect(resA.body.map(w => w.id)).not.toContain(workspaceB.id);
        expect(resB.body.map(w => w.id)).not.toContain(workspaceA.id);
    });

    it('returns 404 (not 403) for another tenant\'s workspace', async () => {
        const res = await request(app).get(`/workspaces/${workspaceA.id}`).set(asB);
        expect(res.status).toBe(404);
    });

    it('returns 404 for a malformed workspace id instead of a database error', async () => {
        const res = await request(app).get('/workspaces/not-a-uuid').set(asA);
        expect(res.status).toBe(404);
    });

    it('lets the owner rename, but not another tenant', async () => {
        const own = await request(app).patch(`/workspaces/${workspaceA.id}`).set(asA).send({ name: 'Renamed' });
        expect(own.status).toBe(200);
        expect(own.body.name).toBe('Renamed');

        const other = await request(app).patch(`/workspaces/${workspaceA.id}`).set(asB).send({ name: 'Hijacked' });
        expect(other.status).toBe(404);
    });
});

describe('brands are isolated per workspace', () => {
    it('creates a brand with aliases and a fact sheet', async () => {
        const res = await request(app)
            .post(`/workspaces/${workspaceA.id}/brands`)
            .set(asA)
            .send({
                name: 'FlyRank',
                aliases: ['FlyRank AI', 'flyrank.ai'],
                fact_sheet: { pricing: { sparrow: 1999, owl: 3499 } }
            });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            workspace_id: workspaceA.id,
            name: 'FlyRank',
            aliases: ['FlyRank AI', 'flyrank.ai'],
            fact_sheet: { pricing: { sparrow: 1999, owl: 3499 } }
        });
        brandA = res.body;
    });

    it('defaults aliases and fact_sheet', async () => {
        const res = await request(app).post(`/workspaces/${workspaceA.id}/brands`).set(asA).send({ name: 'Bare' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ aliases: [], fact_sheet: {} });
    });

    it('rejects a fact_sheet that is not an object', async () => {
        const res = await request(app)
            .post(`/workspaces/${workspaceA.id}/brands`)
            .set(asA)
            .send({ name: 'Bad', fact_sheet: ['not', 'an', 'object'] });
        expect(res.status).toBe(400);
    });

    it('partially updates a brand and bumps updated_at', async () => {
        const res = await request(app)
            .patch(`/workspaces/${workspaceA.id}/brands/${brandA.id}`)
            .set(asA)
            .send({ fact_sheet: { pricing: { sparrow: 1999 }, as_of: '2026-10-14' } });
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('FlyRank'); // untouched
        expect(res.body.fact_sheet.as_of).toBe('2026-10-14');
        expect(new Date(res.body.updated_at) >= new Date(brandA.updated_at)).toBe(true);
    });

    it('rejects an empty update', async () => {
        const res = await request(app).patch(`/workspaces/${workspaceA.id}/brands/${brandA.id}`).set(asA).send({});
        expect(res.status).toBe(400);
    });

    it('hides the brand from another tenant via their own workspace path', async () => {
        // B is a real member of workspaceB but brandA belongs to workspaceA
        const base = `/workspaces/${workspaceB.id}/brands/${brandA.id}`;
        expect((await request(app).get(base).set(asB)).status).toBe(404);
        expect((await request(app).patch(base).set(asB).send({ name: 'Hijacked' })).status).toBe(404);
        expect((await request(app).delete(base).set(asB)).status).toBe(404);

        const list = await request(app).get(`/workspaces/${workspaceB.id}/brands`).set(asB);
        expect(list.body.map(b => b.id)).not.toContain(brandA.id);
    });

    it('hides the brand from another tenant via the owner\'s workspace path', async () => {
        const res = await request(app).get(`/workspaces/${workspaceA.id}/brands/${brandA.id}`).set(asB);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Workspace not found');
    });

    it('brand is unchanged after the hijack attempts', async () => {
        const res = await request(app).get(`/workspaces/${workspaceA.id}/brands/${brandA.id}`).set(asA);
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('FlyRank');
    });

    it('deletes a brand, then 404s', async () => {
        const del = await request(app).delete(`/workspaces/${workspaceA.id}/brands/${brandA.id}`).set(asA);
        expect(del.status).toBe(204);
        const get = await request(app).get(`/workspaces/${workspaceA.id}/brands/${brandA.id}`).set(asA);
        expect(get.status).toBe(404);
    });
});

describe('workspace deletion', () => {
    it('another tenant cannot delete it; the owner can, and it cascades', async () => {
        expect((await request(app).delete(`/workspaces/${workspaceA.id}`).set(asB)).status).toBe(404);

        const del = await request(app).delete(`/workspaces/${workspaceA.id}`).set(asA);
        expect(del.status).toBe(204);

        const { rows } = await pool.query('SELECT count(*)::int AS n FROM brands WHERE workspace_id = $1', [workspaceA.id]);
        expect(rows[0].n).toBe(0);
    });
});
