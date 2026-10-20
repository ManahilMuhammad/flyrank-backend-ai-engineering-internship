import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// different fake users from other test files (running in parallel)
const USERS = {
    'token-g': { id: '00000000-0000-4000-8000-000000000010', email: 'g@test.local' },
    'token-h': { id: '00000000-0000-4000-8000-000000000011', email: 'h@test.local' }
};
vi.mock('../src/lib/supabase.js', () => ({
    getUserFromToken: async token => USERS[token] ?? null,
    signUp: async () => { throw new Error('not used in tests'); },
    signIn: async () => { throw new Error('not used in tests'); }
}));
vi.mock('../src/lib/gemini.js', () => ({
    generateJson: vi.fn(),
    generateGrounded: vi.fn(),
    assertConfigured: vi.fn()
}));
vi.mock('../src/lib/jobs.js', () => ({ enqueueHarvest: vi.fn(async () => 'job-id'), enqueueFetch: vi.fn(async () => 'job-id') }));

const { generateGrounded } = await import('../src/lib/gemini.js');
const { runHarvest } = await import('../src/services/harvester.js');
const { scoreRun } = await import('../src/db/influence.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asG = { Authorization: 'Bearer token-g' };
const asH = { Authorization: 'Bearer token-h' };

// direct page urls so nothing fetched
const P1 = 'https://alpha.influence-test.dev/a';
const P2 = 'https://beta.influence-test.dev/x';
const P3 = 'https://beta.influence-test.dev/y';

const grounded = (pages, lengths) => ({
    text: 'answer',
    chunks: pages.map(uri => ({ uri, title: null })),
    supports: lengths.map((length, i) => ({ chunkIndices: [i], length })),
    searchQueries: [],
    model: 'test-model'
});

// 2 queries x 2 samples = 4 answers:
// query A both samples: P1 60% / P2 40%
// query B sample 1: P1 50% / P3 50%
// query B sample 2: no grounding
// so over 4 answers: P1 = (0.6 + 0.6 + 0.5) / 4 = 0.425, P2 = 0.8 / 4 = 0.2, P3 = 0.5 / 4 = 0.125
const calls = {};
generateGrounded.mockImplementation(async prompt => {
    calls[prompt] = (calls[prompt] ?? 0) + 1;
    if (prompt === 'query a') return grounded([P1, P2], [60, 40]);
    return calls[prompt] === 1 ? grounded([P1, P3], [50, 50]) : grounded([], []);
});

let ws, category, run;
const runs = () => `/workspaces/${ws.id}/categories/${category.id}/runs`;
const get = path => request(app).get(`${runs()}/${run.id}${path}`).set(asG);

beforeAll(async () => {
    await migrate();
    ws = (await request(app).post('/workspaces').set(asG).send({ name: 'G workspace' })).body;
    await request(app).post('/workspaces').set(asH).send({ name: 'H workspace' });
    const brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asG).send({ name: 'FlyRank' })).body;
    category = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asG)
        .send({ brand_id: brand.id, name: 'GEO tools' })).body;
    await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/queries`).set(asG)
        .send({ queries: [{ text: 'query a' }, { text: 'query b' }] });

    run = (await request(app).post(runs()).set(asG).send({ samples_per_query: 2 })).body;
    await runHarvest(run.id, { minIntervalMs: 0, rateLimitPauseMs: 0 });
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-g'].id, USERS['token-h'].id]]
    );
    await pool.query(`DELETE FROM sources WHERE domain LIKE '%influence-test.dev'`);
    await pool.end();
});

describe('source influence', () => {
    it('ranks sources by mean share of support across all answers', async () => {
        const res = await get('/sources');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ run_id: run.id, answers: 4, group_by: 'url' });

        const [s1, s2, s3] = res.body.sources;
        expect(res.body.sources).toHaveLength(3);
        expect(s1).toMatchObject({ rank: 1, url: P1, domain: 'alpha.influence-test.dev', citation_count: 3, query_count: 2 });
        expect(s1.influence).toBeCloseTo(0.425);
        expect(s1.citation_rate).toBeCloseTo(0.75);
        expect(s2).toMatchObject({ rank: 2, url: P2, citation_count: 2, query_count: 1 });
        expect(s2.influence).toBeCloseTo(0.2);
        expect(s3).toMatchObject({ rank: 3, url: P3, citation_count: 1 });
        expect(s3.influence).toBeCloseTo(0.125);
    });

    it('respects limit', async () => {
        const res = await get('/sources?limit=1');
        expect(res.body.sources.map(s => s.url)).toEqual([P1]);
    });

    it('rolls sources up by domain, counting each answer once', async () => {
        const res = await get('/sources?group_by=domain');
        expect(res.status).toBe(200);
        const [alpha, beta] = res.body.sources;
        expect(alpha).toMatchObject({ rank: 1, domain: 'alpha.influence-test.dev', pages: 1, citation_count: 3 });
        expect(alpha.influence).toBeCloseTo(0.425);
        // P2 in answers A1, A2
        // P3 in B1 
        // -> 3 answers (0.4 + 0.4 + 0.5) / 4
        expect(beta).toMatchObject({ rank: 2, domain: 'beta.influence-test.dev', pages: 2, citation_count: 3, query_count: 2 });
        expect(beta.influence).toBeCloseTo(0.325);
        expect(beta.citation_rate).toBeCloseTo(0.75);
    });

    it('scoring again gives the same ranking', async () => {
        const before = (await get('/sources')).body.sources;
        expect(await scoreRun(run.id)).toBe(3);
        expect((await get('/sources')).body.sources).toEqual(before);
    });

    it('rejects bad query parameters', async () => {
        expect((await get('/sources?limit=0')).status).toBe(400);
        expect((await get('/sources?limit=abc')).status).toBe(400);
        const res = await get('/sources?group_by=page');
        expect(res.status).toBe(400);
        expect(res.body.details[0].path).toBe('group_by');
    });
});

describe('co-citation graph', () => {
    const ids = async () => Object.fromEntries((await get('/sources')).body.sources.map(s => [s.url, s.source_id]));

    it('links sources cited in the same answer, ignoring one-off pairs by default', async () => {
        const id = await ids();
        const res = await get('/graph');
        expect(res.status).toBe(200);
        expect(res.body.nodes).toHaveLength(3);
        // P1 + P2 together in 2 answers
        // P1 + P3 only once
        expect(res.body.edges).toHaveLength(1);
        const [edge] = res.body.edges;
        expect([edge.source_a, edge.source_b].sort()).toEqual([id[P1], id[P2]].sort());
        expect(edge.together).toBe(2);
        expect(edge.jaccard).toBeCloseTo(2 / 3); // 2 together / (3 + 2 - 2) answers citing either
    });

    it('can include rarer pairs', async () => {
        const res = await get('/graph?min_together=1');
        expect(res.body.edges.map(e => e.together)).toEqual([2, 1]);
    });

    it('only links sources within the limit', async () => {
        const res = await get('/graph?limit=1&min_together=1');
        expect(res.body.nodes).toHaveLength(1);
        expect(res.body.edges).toHaveLength(0);
    });
});

describe('access', () => {
    it('is invisible to another tenant', async () => {
        const res = await request(app).get(`${runs()}/${run.id}/sources`).set(asH);
        expect(res.status).toBe(404);
    });

    it('is not available until a run completes', async () => {
        const queued = (await request(app).post(runs()).set(asG).send({})).body;
        for (const path of ['sources', 'graph']) {
            const res = await request(app).get(`${runs()}/${queued.id}/${path}`).set(asG);
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('Run is queued; influence is available once it completes');
        }
    });
});
