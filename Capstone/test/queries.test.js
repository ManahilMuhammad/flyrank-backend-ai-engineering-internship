import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// different fake users from tenancy.test.js
// test files run in parallel and each cleans up its own users
const USERS = {
    'token-c': { id: '00000000-0000-4000-8000-00000000000c', email: 'c@test.local' },
    'token-d': { id: '00000000-0000-4000-8000-00000000000d', email: 'd@test.local' }
};
vi.mock('../src/lib/supabase.js', () => ({
    getUserFromToken: async token => USERS[token] ?? null,
    signUp: async () => { throw new Error('not used in tests'); },
    signIn: async () => { throw new Error('not used in tests'); }
}));

// replace gemini with canned response so tests free, fast, deterministic
vi.mock('../src/lib/gemini.js', () => ({ generateJson: vi.fn() }));

const { generateJson } = await import('../src/lib/gemini.js');
const { httpError } = await import('../src/lib/errors.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asC = { Authorization: 'Bearer token-c' };
const asD = { Authorization: 'Bearer token-d' };

const LLM_GROUPS = [
    { intent: 'recommendation', queries: ['best ai search visibility tool', 'which geo platform should i use for my saas', 'Best AI search visibility tool?'] },
    { intent: 'alternatives', queries: ['alternatives to flyrank', 'cheaper geo tools for small teams', 'budget friendly ai visibility software'] },
    { intent: 'comparison', queries: ['geo agency vs geo software', 'should i hire an agency or buy a tool for ai search', 'ai seo agency or diy platform'] }
];

let ws, wsD, brand, brandD, category;
const base = () => `/workspaces/${ws.id}/categories`;

beforeAll(async () => {
    await migrate();

    ws = (await request(app).post('/workspaces').set(asC).send({ name: 'C workspace' })).body;
    wsD = (await request(app).post('/workspaces').set(asD).send({ name: 'D workspace' })).body;
    brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asC)
        .send({ name: 'FlyRank', aliases: ['flyrank.ai'] })).body;
    brandD = (await request(app).post(`/workspaces/${wsD.id}/brands`).set(asD).send({ name: 'Other' })).body;
});

beforeEach(() => {
    generateJson.mockReset();
    generateJson.mockResolvedValue({ data: { groups: LLM_GROUPS }, model: 'test-model' });
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-c'].id, USERS['token-d'].id]]
    );
    await pool.end();
});

describe('categories', () => {
    it('creates a category for a brand in the same workspace', async () => {
        const res = await request(app).post(base()).set(asC).send({
            brand_id: brand.id,
            name: 'AI search visibility / GEO tools',
            description: 'Software and agencies that help brands get cited by ChatGPT, Gemini and Perplexity'
        });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ brand_id: brand.id, active_query_count: 0 });
        category = res.body;
    });

    it('refuses a brand from another workspace', async () => {
        const res = await request(app).post(base()).set(asC).send({ brand_id: brandD.id, name: 'Sneaky' });
        expect(res.status).toBe(400);
        expect(res.body.details[0]).toEqual({ path: 'brand_id', message: 'Brand not found in this workspace' });
    });

    it('refuses a malformed brand_id', async () => {
        const res = await request(app).post(base()).set(asC).send({ brand_id: 'nope', name: 'x' });
        expect(res.status).toBe(400);
    });

    it('is invisible to another tenant', async () => {
        expect((await request(app).get(`${base()}/${category.id}`).set(asD)).status).toBe(404);
        // D using their own workspace path with C's category id
        const viaOwn = await request(app).get(`/workspaces/${wsD.id}/categories/${category.id}/queries`).set(asD);
        expect(viaOwn.status).toBe(404);
        expect(viaOwn.body.error).toBe('Category not found');
        const gen = await request(app).post(`/workspaces/${wsD.id}/categories/${category.id}/queries/generate`).set(asD).send({});
        expect(gen.status).toBe(404);
        expect(generateJson).not.toHaveBeenCalled(); // no llm spend on someone else's category
    });

    it('updates name and description', async () => {
        const res = await request(app).patch(`${base()}/${category.id}`).set(asC).send({ description: null });
        expect(res.status).toBe(200);
        expect(res.body.description).toBeNull();
        await request(app).patch(`${base()}/${category.id}`).set(asC)
            .send({ description: 'Software and agencies that help brands get cited by AI assistants' });
    });
});

describe('query generation', () => {
    const gen = () => `${base()}/${category.id}/queries/generate`;
    const list = () => `${base()}/${category.id}/queries`;

    it('previews without saving, and cleans the LLM output', async () => {
        const res = await request(app).post(gen()).set(asC).send({ count: 60 });
        expect(res.status).toBe(200);
        expect(res.body.saved).toBe(false);
        expect(res.body.model).toBe('test-model');
        expect(res.body.queries).toHaveLength(7); // 9 generated - 1 duplicate - 1 brand mention
        expect(res.body.dropped).toEqual([
            { text: 'Best AI search visibility tool?', reason: 'duplicate' },
            { text: 'alternatives to flyrank', reason: 'mentions_brand' }
        ]);

        expect((await request(app).get(list()).set(asC)).body).toHaveLength(0);
    });

    it('passes the category (not the brand) to the prompt', async () => {
        await request(app).post(gen()).set(asC).send({ count: 30 });
        const { prompt } = generateJson.mock.calls[0][0];
        expect(prompt).toContain('AI search visibility / GEO tools');
        expect(prompt).toContain('cited by AI assistants');
        expect(prompt).not.toMatch(/flyrank/i);
    });

    it('asks for ~25% extra to survive filtering', async () => {
        await request(app).post(gen()).set(asC).send({ count: 60 });
        expect(generateJson.mock.calls[0][0].prompt).toContain('Write 25 groups'); // ceil(60 * 1.25 / 3)
    });

    it('saves with seed/variant links and provenance', async () => {
        const res = await request(app).post(gen()).set(asC).send({ count: 60, save: true });
        expect(res.status).toBe(201);
        expect(res.body.saved).toBe(true);
        expect(res.body.queries).toHaveLength(7);

        const saved = (await request(app).get(list()).set(asC)).body;
        expect(saved).toHaveLength(7);
        expect(saved.every(q => q.origin === 'generated' && q.generation_model === 'test-model')).toBe(true);

        const seed = saved.find(q => q.text === 'cheaper geo tools for small teams');
        const variant = saved.find(q => q.text === 'budget friendly ai visibility software');
        expect(seed.variant_of).toBeNull();
        expect(variant.variant_of).toBe(seed.id);

        const cat = (await request(app).get(`${base()}/${category.id}`).set(asC)).body;
        expect(cat.active_query_count).toBe(7);
    });

    it('does not re-add queries the category already has', async () => {
        const res = await request(app).post(gen()).set(asC).send({ save: true });
        expect(res.body.queries).toHaveLength(0);
        expect(res.body.dropped.filter(d => d.reason === 'duplicate')).toHaveLength(8);
        expect((await request(app).get(list()).set(asC)).body).toHaveLength(7);
    });

    it('validates count', async () => {
        expect((await request(app).post(gen()).set(asC).send({ count: 1000 })).status).toBe(400);
        expect((await request(app).post(gen()).set(asC).send({ count: '60' })).status).toBe(400);
        expect(generateJson).not.toHaveBeenCalled();
    });

    it('returns 502 when the LLM output has the wrong shape', async () => {
        generateJson.mockResolvedValue({ data: { groups: [{ intent: 'made_up', queries: ['x'] }] }, model: 'test-model' });
        const res = await request(app).post(gen()).set(asC).send({});
        expect(res.status).toBe(502);
        expect(res.body.error).toBe('LLM output did not match the expected shape');
    });

    it('passes through LLM errors like a missing key or rate limit', async () => {
        generateJson.mockRejectedValue(httpError(503, 'LLM is not configured (missing GEMINI_API_KEY)'));
        expect((await request(app).post(gen()).set(asC).send({})).status).toBe(503);

        generateJson.mockRejectedValue(httpError(429, 'LLM rate limit reached, try again in a minute'));
        expect((await request(app).post(gen()).set(asC).send({})).status).toBe(429);
    });
});

describe('managing queries', () => {
    const list = () => `${base()}/${category.id}/queries`;
    let manual;

    it('adds queries by hand and skips duplicates', async () => {
        const res = await request(app).post(list()).set(asC).send({
            queries: [
                { text: 'how do i get my brand mentioned in chatgpt answers', intent: 'how_to' },
                { text: 'cheaper geo tools for small teams' } // already exists
            ]
        });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ added: 1, skipped_duplicates: 1 });
        manual = res.body.queries[0];
        expect(manual).toMatchObject({ origin: 'manual', generation_model: null, intent: 'how_to' });
    });

    it('rejects an unknown intent', async () => {
        const res = await request(app).post(list()).set(asC).send({ queries: [{ text: 'some question', intent: 'vibes' }] });
        expect(res.status).toBe(400);
    });

    it('deactivates a query and filters by active', async () => {
        const res = await request(app).patch(`${list()}/${manual.id}`).set(asC).send({ active: false });
        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);

        const inactive = (await request(app).get(`${list()}?active=false`).set(asC)).body;
        expect(inactive.map(q => q.id)).toEqual([manual.id]);
        const active = (await request(app).get(`${list()}?active=true`).set(asC)).body;
        expect(active.map(q => q.id)).not.toContain(manual.id);
    });

    it('returns 409 when renaming to an existing query', async () => {
        const res = await request(app).patch(`${list()}/${manual.id}`).set(asC).send({ text: 'cheaper geo tools for small teams' });
        expect(res.status).toBe(409);
    });

    it('another tenant cannot edit or delete a query', async () => {
        const viaOwn = `/workspaces/${wsD.id}/categories/${category.id}/queries/${manual.id}`;
        expect((await request(app).patch(viaOwn).set(asD).send({ active: true })).status).toBe(404);
        expect((await request(app).delete(viaOwn).set(asD)).status).toBe(404);
    });

    it('deletes a query', async () => {
        expect((await request(app).delete(`${list()}/${manual.id}`).set(asC)).status).toBe(204);
        expect((await request(app).delete(`${list()}/${manual.id}`).set(asC)).status).toBe(404);
    });

    it('deleting the category removes its queries', async () => {
        expect((await request(app).delete(`${base()}/${category.id}`).set(asC)).status).toBe(204);
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM queries WHERE category_id = $1', [category.id]);
        expect(rows[0].n).toBe(0);
    });
});
