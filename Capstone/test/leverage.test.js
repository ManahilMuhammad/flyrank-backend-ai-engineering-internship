import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// different fake users from other test files (running in parallel)
const USERS = {
    'token-l': { id: '00000000-0000-4000-8000-000000000015', email: 'l@test.local' },
    'token-m': { id: '00000000-0000-4000-8000-000000000016', email: 'm@test.local' }
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
vi.mock('../src/lib/jobs.js', () => ({
    enqueueHarvest: vi.fn(async () => 'job-id'),
    enqueueFetch: vi.fn(async () => 'job-id'),
    enqueueAudit: vi.fn(async () => 'job-id')
}));

const { generateJson, generateGrounded } = await import('../src/lib/gemini.js');
const { deficitFor, actionFor, computeHeadline } = await import('../src/services/leverage.js');
const { auditRunSources } = await import('../src/services/standingAuditor.js');
const { runHarvest } = await import('../src/services/harvester.js');
const snapshots = await import('../src/db/snapshots.js');
const { contentHash } = await import('../src/lib/extract.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asL = { Authorization: 'Bearer token-l' };
const asM = { Authorization: 'Bearer token-m' };

describe('deficitFor and actionFor', () => {
    it('scores how far each stance is from a good description', () => {
        expect(deficitFor({ stance: 'absent', is_stale: false })).toBe(1);
        expect(deficitFor({ stance: 'unfavorable', is_stale: false })).toBe(0.9);
        expect(deficitFor({ stance: 'neutral', is_stale: false })).toBe(0.4);
        expect(deficitFor({ stance: 'favorable', is_stale: false })).toBe(0);
    });

    it('treats stale facts as at least 0.8, even on a favorable page', () => {
        expect(deficitFor({ stance: 'favorable', is_stale: true })).toBe(0.8);
        expect(deficitFor({ stance: 'unfavorable', is_stale: true })).toBe(0.9);
    });

    it('names the fix, stale first', () => {
        expect(actionFor({ stance: 'favorable', is_stale: true })).toBe('correct_stale_info');
        expect(actionFor({ stance: 'absent', is_stale: false })).toBe('get_included');
        expect(actionFor({ stance: 'unfavorable', is_stale: false })).toBe('address_criticism');
        expect(actionFor({ stance: 'neutral', is_stale: false })).toBe('improve_mention');
        expect(actionFor({ stance: 'favorable', is_stale: false })).toBeNull();
    });
});

describe('computeHeadline', () => {
    it('handles a run with no answers or sources', () => {
        const h = computeHeadline({ rows: [], answers: { total: 0, mentioned: 0, grounded: 0, citing_owned: 0 }, brandDomains: [], topN: 40 });
        expect(h).toMatchObject({ answers: 0, brand_mention_rate: null, top5_concentration: null, audit_coverage: null, total_leverage: 0 });
    });
});

// --> one answer citing seven pages with known shares so influence = share

const PAGES = {
    owned:      { url: 'https://www.flyrank.ai/pricing', share: 30, text: 'FlyRank pricing: Sparrow $1,999/mo.' },
    stale:      { url: 'https://a.leverage-test.dev/best-geo-tools', share: 20,
        text: 'Best GEO tools\nFlyRank is our top pick and starts at $1,499 per month.' },
    missing:    { url: 'https://b.leverage-test.dev/geo-roundup', share: 15, text: 'GEO roundup\nTools like Peec AI and Profound lead the market.' },
    critical:   { url: 'https://c.leverage-test.dev/thread', share: 10, text: 'Thread\nFlyRank was too expensive for our small team.' },
    neutral:    { url: 'https://d.leverage-test.dev/vendors', share: 10, text: 'Vendors\nVendors include FlyRank among many others.' },
    favorable:  { url: 'https://e.leverage-test.dev/review', share: 10, text: 'Review\nFlyRank did a great job for our brand.' },
    blocked:    { url: 'https://f.leverage-test.dev/reviews', share: 5, text: null }
};
const VERDICTS = {
    stale: { stance: 'favorable', is_stale: true, stale_reason: 'Says $1,499; fact sheet says $1,999',
        evidence_passage: 'FlyRank is our top pick and starts at $1,499 per month.' },
    critical: { stance: 'unfavorable', is_stale: false, stale_reason: '', evidence_passage: 'FlyRank was too expensive for our small team.' },
    neutral: { stance: 'neutral', is_stale: false, stale_reason: '', evidence_passage: 'Vendors include FlyRank among many others.' },
    favorable: { stance: 'favorable', is_stale: false, stale_reason: '', evidence_passage: 'FlyRank did a great job for our brand.' }
};

let ws, category, run;
const runUrl = () => `/workspaces/${ws.id}/categories/${category.id}/runs/${run.id}`;
const ids = {};

beforeAll(async () => {
    await migrate();
    ws = (await request(app).post('/workspaces').set(asL).send({ name: 'L workspace' })).body;
    await request(app).post('/workspaces').set(asM).send({ name: 'M workspace' });
    const brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asL).send({
        name: 'FlyRank', domains: ['flyrank.ai'], fact_sheet: { pricing_usd_per_month: { Sparrow: 1999 } }
    })).body;
    category = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asL)
        .send({ brand_id: brand.id, name: 'GEO tools' })).body;
    await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/queries`).set(asL)
        .send({ queries: [{ text: 'best geo tools' }] });

    const pages = Object.values(PAGES);
    generateGrounded.mockResolvedValue({
        text: 'FlyRank and others are popular.',
        chunks: pages.map(p => ({ uri: p.url, title: null })),
        supports: pages.map((p, i) => ({ chunkIndices: [i], length: p.share })),
        searchQueries: [],
        model: 'test-model'
    });
    generateJson.mockImplementation(async ({ prompt }) => {
        const key = Object.keys(VERDICTS).find(k => prompt.includes(PAGES[k].url));
        return { data: { confidence: 0.9, ...VERDICTS[key] }, model: 'test-model' };
    });

    run = (await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/runs`).set(asL)
        .send({ samples_per_query: 1 })).body;
    await runHarvest(run.id, { minIntervalMs: 0 });

    const { rows } = await pool.query('SELECT id, url_canonical FROM sources WHERE url_canonical = ANY($1)', [pages.map(p => p.url)]);
    for (const [key, page] of Object.entries(PAGES)) {
        ids[key] = rows.find(r => r.url_canonical === page.url).id;
        const snapshot = page.text === null
            ? { id: await snapshots.saveFailedSnapshot(ids[key], { status: 'fetch_failed', httpStatus: 403, error: 'HTTP 403' }) }
            : await snapshots.saveTextSnapshot(ids[key], { hash: contentHash(page.text), text: page.text, httpStatus: 200, finalUrl: page.url });
        await snapshots.linkSnapshot(run.id, ids[key], snapshot.id);
    }
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-l'].id, USERS['token-m'].id]]
    );
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [Object.values(ids)]);
    await pool.end();
});

describe('leverage for a run', () => {
    it('is not available until the run is audited', async () => {
        const res = await request(app).get(`${runUrl()}/leverage`).set(asL);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/not been audited yet/);
    });

    it('ranks the fixes by influence x deficit', async () => {
        await auditRunSources(run.id, { minIntervalMs: 0 });
        const res = await request(app).get(`${runUrl()}/leverage`).set(asL);
        expect(res.status).toBe(200);

        const actions = res.body.actions;
        // stale 0.20 x 0.8 = 0.16, missing 0.15 x 1 = 0.15, critical 0.10 x 0.9 = 0.09, neutral 0.10 x 0.4 = 0.04
        expect(actions.map(a => a.url)).toEqual([PAGES.stale.url, PAGES.missing.url, PAGES.critical.url, PAGES.neutral.url]);
        expect(actions.map(a => a.leverage_rank)).toEqual([1, 2, 3, 4]);
        expect(actions.map(a => a.action)).toEqual(['correct_stale_info', 'get_included', 'address_criticism', 'improve_mention']);
        [0.16, 0.15, 0.09, 0.04].forEach((lev, i) => expect(actions[i].leverage).toBeCloseTo(lev));
        expect(actions[0]).toMatchObject({ deficit: 0.8, stance: 'favorable', is_stale: true,
            evidence_passage: 'FlyRank is our top pick and starts at $1,499 per month.' });
        expect(actions[1]).toMatchObject({ stance: 'absent', deficit: 1 });
    });

    it('leaves out owned pages and pages that are already favorable', async () => {
        const urls = (await request(app).get(`${runUrl()}/leverage`).set(asL)).body.actions.map(a => a.url);
        expect(urls).not.toContain(PAGES.owned.url);
        expect(urls).not.toContain(PAGES.favorable.url);
    });

    it('lists top sources it could not audit, so they are not silently dropped', async () => {
        const { unaudited } = (await request(app).get(`${runUrl()}/leverage`).set(asL)).body;
        expect(unaudited).toHaveLength(1); // the owned page has no verdict either, but is not listed
        expect(unaudited[0]).toMatchObject({ url: PAGES.blocked.url, fetch_status: 'fetch_failed', audit_note: 'not readable: fetch_failed' });
        expect(unaudited[0].influence).toBeCloseTo(0.05);
        expect(unaudited[0]).not.toHaveProperty('leverage');
    });

    it('reports headline numbers', async () => {
        const { headline } = (await request(app).get(`${runUrl()}/leverage`).set(asL)).body;
        expect(headline).toMatchObject({ answers: 1, brand_mention_rate: 1, owned_citation_rate: 1, grounded_answer_rate: 1, sources: 7 });
        expect(headline.top5_concentration).toBeCloseTo(0.85);    // 0.30 + 0.20 + 0.15 + 0.10 + 0.10
        expect(headline.owned_influence_share).toBeCloseTo(0.3);
        expect(headline.audit_coverage).toBeCloseTo(0.65 / 0.7); // third-party 0.70, of which 0.65 has a verdict
        expect(headline.stance_mix.favorable).toBeCloseTo(0.3 / 0.65);
        expect(headline.stance_mix.absent).toBeCloseTo(0.15 / 0.65);
        expect(headline.stance_mix.unfavorable).toBeCloseTo(0.1 / 0.65);
        expect(headline.stance_mix.neutral).toBeCloseTo(0.1 / 0.65);
        expect(headline.stale_share).toBeCloseTo(0.2 / 0.65);
        expect(headline.total_leverage).toBeCloseTo(0.44);

        const runRes = (await request(app).get(runUrl()).set(asL)).body;
        expect(runRes.stats.headline).toEqual(headline); // also on the run itself
    });

    it('re-scores when the audit runs again, without changing the result', async () => {
        const before = (await request(app).get(`${runUrl()}/leverage`).set(asL)).body.actions;
        generateJson.mockClear();
        await auditRunSources(run.id, { minIntervalMs: 0 });
        expect(generateJson).not.toHaveBeenCalled(); // all verdicts cached
        expect((await request(app).get(`${runUrl()}/leverage`).set(asL)).body.actions).toEqual(before);
    });

    it('respects limit and validates it', async () => {
        const res = await request(app).get(`${runUrl()}/leverage?limit=2`).set(asL);
        expect(res.body.actions).toHaveLength(2);
        expect((await request(app).get(`${runUrl()}/leverage?limit=0`).set(asL)).status).toBe(400);
    });

    it('is invisible to another tenant', async () => {
        expect((await request(app).get(`${runUrl()}/leverage`).set(asM)).status).toBe(404);
    });
});
