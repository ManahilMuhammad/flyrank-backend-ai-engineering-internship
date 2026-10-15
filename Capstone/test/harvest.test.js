import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// different fake users from other test files (run in parallel)
const USERS = {
    'token-e': { id: '00000000-0000-4000-8000-00000000000e', email: 'e@test.local' },
    'token-f': { id: '00000000-0000-4000-8000-00000000000f', email: 'f@test.local' }
};
vi.mock('../src/lib/supabase.js', () => ({
    getUserFromToken: async token => USERS[token] ?? null,
    signUp: async () => { throw new Error('not used in tests'); },
    signIn: async () => { throw new Error('not used in tests'); }
}));

// tests call runHarvest directly
vi.mock('../src/lib/gemini.js', () => ({
    generateJson: vi.fn(),
    generateGrounded: vi.fn(),
    assertConfigured: vi.fn()
}));
vi.mock('../src/lib/jobs.js', () => ({ enqueueHarvest: vi.fn(async () => 'job-id') }));

const { generateGrounded, assertConfigured } = await import('../src/lib/gemini.js');
const { enqueueHarvest } = await import('../src/lib/jobs.js');
const { httpError } = await import('../src/lib/errors.js');
const { runHarvest } = await import('../src/services/harvester.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asE = { Authorization: 'Bearer token-e' };
const asF = { Authorization: 'Bearer token-f' };
const FAST = { minIntervalMs: 0, rateLimitPauseMs: 0 };

// grounding redirects and pages they lead to (all on a test-only domain)
const redirect = n => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/priors-test-${n}`;
const PAGES = {
    [redirect(1)]: 'https://www.reviews.priors-test.dev/geo-tools?utm_source=gemini',
    [redirect(2)]: 'https://www.reviews.priors-test.dev/geo-tools/',
    [redirect(3)]: 'https://forum.priors-test.dev/t/best-geo-tool'
    // redirect(4) unknown: redirect endpoint answers 404
};
const fetchMock = vi.fn(async uri => PAGES[uri]
    ? new Response(null, { status: 302, headers: { location: PAGES[uri] } })
    : new Response('gone', { status: 404 }));

function groundedAnswer(text) {
    return {
        text,
        chunks: [
            { uri: redirect(1), title: 'reviews.priors-test.dev' },
            { uri: redirect(2), title: 'Best GEO tools 2026' },
            { uri: redirect(3), title: 'forum.priors-test.dev' },
            { uri: redirect(4), title: 'lost.priors-test.dev' }
        ],
        supports: [
            { chunkIndices: [0], length: 30 },
            { chunkIndices: [1], length: 20 },
            { chunkIndices: [2], length: 40 },
            { chunkIndices: [3], length: 10 }
        ],
        searchQueries: ['best geo tools 2026'],
        model: 'test-model'
    };
}

let ws, wsF, category, emptyCategory;
const runs = () => `/workspaces/${ws.id}/categories/${category.id}/runs`;

async function startRun(body = {}) {
    const res = await request(app).post(runs()).set(asE).send(body);
    expect(res.status).toBe(202);
    return res.body;
}

beforeAll(async () => {
    await migrate();
    vi.stubGlobal('fetch', fetchMock);

    ws = (await request(app).post('/workspaces').set(asE).send({ name: 'E workspace' })).body;
    wsF = (await request(app).post('/workspaces').set(asF).send({ name: 'F workspace' })).body;
    const brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asE)
        .send({ name: 'FlyRank', aliases: ['flyrank.ai'] })).body;
    category = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asE)
        .send({ brand_id: brand.id, name: 'GEO tools' })).body;
    emptyCategory = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asE)
        .send({ brand_id: brand.id, name: 'No queries yet' })).body;
    await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/queries`).set(asE).send({
        queries: [{ text: 'best ai search visibility tool' }, { text: 'cheaper geo tools for small teams' }]
    });
});

beforeEach(() => {
    generateGrounded.mockReset();
    // first query's answers mention brand, second's dont
    generateGrounded.mockImplementation(async prompt => groundedAnswer(
        prompt.startsWith('best') ? 'Popular picks include FlyRank and others.' : 'Try a smaller tool.'
    ));
    enqueueHarvest.mockClear();
    fetchMock.mockClear();
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-e'].id, USERS['token-f'].id]]
    );
    // sources and resolutions are global
    // clean up test domain explicitly
    await pool.query(`DELETE FROM sources WHERE domain LIKE '%priors-test.dev'`);
    await pool.query(`DELETE FROM url_resolutions WHERE redirect_url LIKE '%priors-test-%'`);
    vi.unstubAllGlobals();
    await pool.end();
});

describe('starting a harvest', () => {
    let run;

    it('queues a run and hands it to the job queue', async () => {
        run = await startRun({ samples_per_query: 2 });
        expect(run).toMatchObject({ status: 'queued', samples_per_query: 2, category_id: category.id });
        expect(enqueueHarvest).toHaveBeenCalledWith(run.id);
    });

    it('refuses a second run while one is queued', async () => {
        const res = await request(app).post(runs()).set(asE).send({});
        expect(res.status).toBe(409);
        expect(enqueueHarvest).not.toHaveBeenCalled();
    });

    it('is invisible to another tenant', async () => {
        expect((await request(app).get(`${runs()}/${run.id}`).set(asF)).status).toBe(404);
        const viaOwn = `/workspaces/${wsF.id}/categories/${category.id}/runs`;
        expect((await request(app).post(viaOwn).set(asF).send({})).status).toBe(404);
        expect((await request(app).get(`${viaOwn}/${run.id}`).set(asF)).status).toBe(404);
    });

    it('stores every (query, sample) answer with merged, weighted citations', async () => {
        await runHarvest(run.id, FAST);
        expect(generateGrounded).toHaveBeenCalledTimes(4); // 2 queries x 2 samples

        const done = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(done.status).toBe('completed');
        expect(done.started_at).not.toBeNull();
        expect(done.finished_at).not.toBeNull();
        expect(done.stats).toMatchObject({
            queries: 2,
            calls_planned: 4,
            calls_done: 4,
            calls_failed: 0,
            answers: 4,
            brand_mentions: 2,
            brand_mention_rate: 0.5,
            ungrounded_answers: 0,
            citations: 8, // 2 distinct pages per answer
            unique_sources: 2,
            unique_domains: 2,
            new_sources: 2,
            unresolved_chunks: 4, // redirect(4) in every answer
            // first answer resolves 3 redirects (1 fails), other 3 answers hit cache
            redirects: { resolved: 3, cached: 9, failed: 4 }
        });

        const answers = (await request(app).get(`${runs()}/${run.id}/answers`).set(asE)).body;
        expect(answers).toHaveLength(4);
        const first = answers.find(a => a.query_text === 'best ai search visibility tool' && a.sample_n === 1);
        expect(first.brand_mentioned).toBe(true);
        expect(answers.find(a => a.query_text === 'cheaper geo tools for small teams').brand_mentioned).toBe(false);
        expect(first.search_queries).toEqual(['best geo tools 2026']);
        expect(first.citations).toHaveLength(2);
        // two links to same review page merged: 30 + 20 out of 100
        expect(first.citations[0]).toMatchObject({ url: 'https://www.reviews.priors-test.dev/geo-tools', domain: 'reviews.priors-test.dev' });
        expect(first.citations[0].support_weight).toBeCloseTo(0.5);
        expect(first.citations[1].support_weight).toBeCloseTo(0.4);
    });

    it('filters answers by query', async () => {
        const all = (await request(app).get(`${runs()}/${run.id}/answers`).set(asE)).body;
        const queryId = all[0].query_id;
        const some = (await request(app).get(`${runs()}/${run.id}/answers?query_id=${queryId}`).set(asE)).body;
        expect(some).toHaveLength(2);
        expect(some.every(a => a.query_id === queryId)).toBe(true);
        expect((await request(app).get(`${runs()}/${run.id}/answers?query_id=nope`).set(asE)).status).toBe(400);
    });

    it('does not re-run a finished run', async () => {
        await runHarvest(run.id, FAST);
        expect(generateGrounded).not.toHaveBeenCalled();
    });

    it('counts sources already seen in this category as not new', async () => {
        const second = await startRun({ samples_per_query: 1 });
        await runHarvest(second.id, FAST);
        const done = (await request(app).get(`${runs()}/${second.id}`).set(asE)).body;
        expect(done.stats).toMatchObject({ answers: 2, unique_sources: 2, new_sources: 0 });

        const list = (await request(app).get(runs()).set(asE)).body;
        expect(list.map(r => r.id)).toEqual([second.id, run.id]); // newest first
    });
});

describe('harvest failures', () => {
    it('refuses a category with no active queries', async () => {
        const res = await request(app).post(`/workspaces/${ws.id}/categories/${emptyCategory.id}/runs`).set(asE).send({});
        expect(res.status).toBe(400);
    });

    it('refuses when the LLM is not configured', async () => {
        assertConfigured.mockImplementationOnce(() => { throw httpError(503, 'LLM is not configured (missing GEMINI_API_KEY)'); });
        expect((await request(app).post(runs()).set(asE).send({})).status).toBe(503);
        expect(enqueueHarvest).not.toHaveBeenCalled();
    });

    it('waits out a rate limit and retries the same call', async () => {
        generateGrounded.mockRejectedValueOnce(httpError(429, 'LLM rate limit reached, try again in a minute'));
        const run = await startRun({ samples_per_query: 1 });
        await runHarvest(run.id, FAST);
        const done = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(done.status).toBe('completed');
        expect(done.stats).toMatchObject({ rate_limit_pauses: 1, calls_done: 2, calls_failed: 0 });
    });

    it('skips a failed call and keeps going', async () => {
        generateGrounded.mockRejectedValueOnce(httpError(502, 'LLM request failed'));
        const run = await startRun({ samples_per_query: 1 });
        await runHarvest(run.id, FAST);
        const done = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(done.status).toBe('completed');
        expect(done.stats).toMatchObject({ calls_done: 1, calls_failed: 1, answers: 1 });
    });

    it('fails a run where every call failed, even below the consecutive limit', async () => {
        generateGrounded.mockRejectedValue(httpError(502, 'LLM request failed'));
        const run = await startRun({ samples_per_query: 1 }); // 2 calls, limit is 5
        await runHarvest(run.id, FAST);
        const done = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(done.status).toBe('failed');
        expect(done.error).toBe('Every call failed (2), no answers stored');
    });

    it('stops after repeated failures and keeps what it has', async () => {
        generateGrounded.mockRejectedValue(httpError(502, 'LLM request failed'));
        const run = await startRun({ samples_per_query: 3 }); // 6 planned calls
        await runHarvest(run.id, FAST);
        const done = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(done.status).toBe('failed');
        expect(done.error).toBe('Stopped after 5 failed calls in a row: LLM request failed');
        expect(generateGrounded).toHaveBeenCalledTimes(5);
        expect(done.stats).toMatchObject({ calls_planned: 6, calls_failed: 5, answers: 0 });
    });

    it('resumes after a crash without repeating saved answers', async () => {
        const run = await startRun({ samples_per_query: 2 });
        generateGrounded
            .mockImplementationOnce(async () => groundedAnswer('one'))
            .mockImplementationOnce(async () => { throw new Error('connection reset'); }); // not an llm error

        await expect(runHarvest(run.id, FAST)).rejects.toThrow('connection reset');
        const crashed = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(crashed.status).toBe('running'); // left for job retry
        expect(crashed.stats.calls_done).toBe(1);

        generateGrounded.mockClear();
        await runHarvest(run.id, FAST); // on retry
        expect(generateGrounded).toHaveBeenCalledTimes(3);
        const done = (await request(app).get(`${runs()}/${run.id}`).set(asE)).body;
        expect(done.status).toBe('completed');
        expect(done.stats).toMatchObject({ answers: 4, calls_done: 4 });
    });
});
