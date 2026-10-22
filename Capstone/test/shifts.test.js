import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// different fake users from other test files (running in parallel)
const USERS = {
    'token-n': { id: '00000000-0000-4000-8000-000000000017', email: 'n@test.local' },
    'token-o': { id: '00000000-0000-4000-8000-000000000018', email: 'o@test.local' }
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

const { generateJson, generateGrounded, assertConfigured } = await import('../src/lib/gemini.js');
const { httpError } = await import('../src/lib/errors.js');
const { diffRuns, detectShifts } = await import('../src/services/shifts.js');
const { runScheduledHarvests } = await import('../src/services/scheduler.js');
const { auditRunSources } = await import('../src/services/standingAuditor.js');
const { runHarvest } = await import('../src/services/harvester.js');
const snapshots = await import('../src/db/snapshots.js');
const { contentHash } = await import('../src/lib/extract.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asN = { Authorization: 'Bearer token-n' };
const asO = { Authorization: 'Bearer token-o' };

// --> diff rules on their own

const src = (id, over = {}) => ({
    source_id: id, url: `https://${id}.example/page`, domain: `${id}.example`,
    citation_rate: 0.5, citation_count: 5, influence: 0.1, stance: null, is_stale: null, ...over
});
const types = events => events.map(e => `${e.type}:${e.sourceId ?? e.payload.metric}`).sort();

describe('diffRuns', () => {
    it('flags a source that entered or left, but only above the noise floor', () => {
        const events = diffRuns(
            { sources: [src('gone'), src('rare-gone', { citation_count: 2, citation_rate: 0.4 })] },
            { sources: [src('new'), src('rare-new', { citation_count: 2 }), src('small-new', { citation_rate: 0.05 })] }
        );
        expect(types(events)).toEqual(['source_entered:new', 'source_exited:gone']);
        expect(events.find(e => e.type === 'source_exited').delta).toBe(-0.5);
    });

    it('treats a source with zero citations as absent', () => {
        const events = diffRuns({ sources: [src('a', { citation_count: 0, citation_rate: 0 })] }, { sources: [src('a')] });
        expect(types(events)).toEqual(['source_entered:a']);
    });

    it('flags citation rate moves of 10 points either way', () => {
        const events = diffRuns(
            { sources: [src('up', { citation_rate: 0.2 }), src('down', { citation_rate: 0.6 }), src('flat', { citation_rate: 0.3 })] },
            { sources: [src('up', { citation_rate: 0.35 }), src('down', { citation_rate: 0.45 }), src('flat', { citation_rate: 0.35 })] }
        );
        expect(types(events)).toEqual(['citation_rate_changed:down', 'citation_rate_changed:up']);
        expect(events.find(e => e.sourceId === 'down').delta).toBeCloseTo(-0.15);
    });

    it('flags a page whose verdict changed, with the change in deficit', () => {
        const events = diffRuns(
            { sources: [src('page', { stance: 'favorable', is_stale: false }), src('same', { stance: 'neutral', is_stale: false })] },
            { sources: [src('page', { stance: 'favorable', is_stale: true, stale_reason: 'old price' }), src('same', { stance: 'neutral', is_stale: false })] }
        );
        expect(types(events)).toEqual(['standing_changed:page']);
        expect(events[0]).toMatchObject({
            delta: 0.8, // favorable 0 -> stale 0.8: worse for brand
            payload: { from: { stance: 'favorable', is_stale: false }, to: { stance: 'favorable', is_stale: true }, stale_reason: 'old price' }
        });
    });

    it('ignores a verdict appearing for the first time (nothing to compare)', () => {
        expect(diffRuns({ sources: [src('a')] }, { sources: [src('a', { stance: 'absent', is_stale: false })] })).toEqual([]);
    });

    it('flags brand-level rate moves of 5 points', () => {
        const events = diffRuns(
            { sources: [], headline: { brand_mention_rate: 0.3, owned_citation_rate: 0.1 } },
            { sources: [], headline: { brand_mention_rate: 0.2, owned_citation_rate: 0.12 } }
        );
        expect(events).toEqual([{
            type: 'citation_rate_changed', sourceId: null, delta: -0.1,
            payload: { metric: 'brand_mention_rate', from: 0.3, to: 0.2 }
        }]);
    });
});

// --> two real runs of one category with forced change between them

const PAGE = {
    a: 'https://a.shifts-test.dev/review',
    b: 'https://b.shifts-test.dev/list',
    c: 'https://c.shifts-test.dev/newcomer'
};
let ws, wsO, category;
const createdSources = new Set();

// harvest 2 queries x 3 samples where every answer cites pages
// then store page texts and audit
async function completedRun({ pages, answerText, texts }) {
    generateGrounded.mockResolvedValue({
        text: answerText,
        chunks: pages.map(uri => ({ uri, title: null })),
        supports: pages.map((_, i) => ({ chunkIndices: [i], length: 10 })),
        searchQueries: [],
        model: 'test-model'
    });
    const run = (await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/runs`).set(asN)
        .send({ samples_per_query: 3 })).body;
    await runHarvest(run.id, { minIntervalMs: 0 });

    const { rows } = await pool.query('SELECT id, url_canonical FROM sources WHERE url_canonical = ANY($1)', [pages]);
    for (const row of rows) {
        createdSources.add(row.id);
        const text = texts[row.url_canonical];
        const saved = await snapshots.saveTextSnapshot(row.id, { hash: contentHash(text), text, httpStatus: 200, finalUrl: row.url_canonical });
        await snapshots.linkSnapshot(run.id, row.id, saved.id);
    }
    await auditRunSources(run.id, { minIntervalMs: 0 });
    return run;
}

let run1, run2;

beforeAll(async () => {
    await migrate();
    ws = (await request(app).post('/workspaces').set(asN).send({ name: 'N workspace' })).body;
    wsO = (await request(app).post('/workspaces').set(asO).send({ name: 'O workspace' })).body;
    const brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asN).send({ name: 'FlyRank' })).body;
    category = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asN)
        .send({ brand_id: brand.id, name: 'GEO tools' })).body;
    await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/queries`).set(asN)
        .send({ queries: [{ text: 'best geo tools' }, { text: 'cheap geo tools' }] });

    // page A is only one naming brand
    // favorable in week 1, unfavorable in week 2
    generateJson.mockImplementation(async ({ prompt }) => ({
        data: prompt.includes('FlyRank is excellent')
            ? { stance: 'favorable', is_stale: false, stale_reason: '', evidence_passage: 'FlyRank is excellent for small teams.', confidence: 0.9 }
            : { stance: 'unfavorable', is_stale: false, stale_reason: '', evidence_passage: 'FlyRank has become too expensive for small teams.', confidence: 0.9 },
        model: 'test-model'
    }));

    // week 1: answers cite A and B, name brand
    run1 = await completedRun({
        pages: [PAGE.a, PAGE.b],
        answerText: 'FlyRank is a good option.',
        texts: { [PAGE.a]: 'Review\nFlyRank is excellent for small teams.', [PAGE.b]: 'List\nSome tools exist.' }
    });
    // week 2: B gone, C appears, A's page turned critical
    // answers stop naming the brand
    run2 = await completedRun({
        pages: [PAGE.a, PAGE.c],
        answerText: 'Several tools are available.',
        texts: { [PAGE.a]: 'Review\nFlyRank has become too expensive for small teams.', [PAGE.c]: 'Newcomer\nAnother tool list.' }
    });
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-n'].id, USERS['token-o'].id]]
    );
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[...createdSources]]);
    await pool.end();
});

describe('detecting shifts between runs', () => {
    it('records nothing for a category\'s first run', async () => {
        expect(await detectShifts(run1.id)).toEqual({ previous_run_id: null, total: 0, by_type: {} });
    });

    it('turns a forced change into shift events', async () => {
        const summary = await detectShifts(run2.id);
        expect(summary).toEqual({
            previous_run_id: run1.id,
            total: 4,
            by_type: { source_entered: 1, source_exited: 1, standing_changed: 1, citation_rate_changed: 1 }
        });

        const res = await request(app).get(`/workspaces/${ws.id}/categories/${category.id}/runs/${run2.id}/shifts`).set(asN);
        expect(res.status).toBe(200);
        expect(res.body.summary).toEqual(summary);
        const byType = Object.fromEntries(res.body.events.map(e => [e.type, e]));
        expect(byType.source_entered).toMatchObject({ url: PAGE.c, delta: 1, prev_run_id: run1.id });
        expect(byType.source_exited).toMatchObject({ url: PAGE.b, delta: -1 });
        expect(byType.standing_changed).toMatchObject({
            url: PAGE.a,
            payload: {
                from: { stance: 'favorable', is_stale: false },
                to: { stance: 'unfavorable', is_stale: false },
                evidence_passage: 'FlyRank has become too expensive for small teams.'
            }
        });
        expect(byType.standing_changed.delta).toBeCloseTo(0.9);
        expect(byType.citation_rate_changed).toMatchObject({
            source_id: null, url: null, delta: -1, payload: { metric: 'brand_mention_rate', from: 1, to: 0 }
        });
    });

    it('rewrites a run\'s events instead of duplicating them', async () => {
        await detectShifts(run2.id);
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM shift_events WHERE run_id = $1', [run2.id]);
        expect(rows[0].n).toBe(4);
    });

    it('serves the category feed, filterable by type', async () => {
        const base = `/workspaces/${ws.id}/categories/${category.id}/shifts`;
        expect((await request(app).get(base).set(asN)).body).toHaveLength(4);
        const exited = (await request(app).get(`${base}?type=source_exited`).set(asN)).body;
        expect(exited.map(e => e.url)).toEqual([PAGE.b]);
        expect((await request(app).get(`${base}?type=vibes`).set(asN)).status).toBe(400);
    });

    it('is invisible to another tenant', async () => {
        expect((await request(app).get(`/workspaces/${ws.id}/categories/${category.id}/shifts`).set(asO)).status).toBe(404);
        expect((await request(app).get(`/workspaces/${wsO.id}/categories/${category.id}/shifts`).set(asO)).status).toBe(404);
    });
});

describe('weekly schedule', () => {
    const enqueue = vi.fn(async () => 'job-id');
    const ours = result => result.runs.filter(Boolean);
    const runsOfCategory = async () =>
        (await pool.query('SELECT id FROM harvest_runs WHERE category_id = $1', [category.id])).rows.map(r => r.id);

    it('only harvests categories that opted in', async () => {
        const before = await runsOfCategory();
        const result = await runScheduledHarvests({ enqueue });
        expect((await runsOfCategory()).length).toBe(before.length);
        expect(ours(result).filter(id => !before.includes(id))).toEqual([]);
    });

    it('starts a run for an opted-in category and hands it to the queue', async () => {
        const patched = await request(app).patch(`/workspaces/${ws.id}/categories/${category.id}`).set(asN).send({ weekly_harvest: true });
        expect(patched.body.weekly_harvest).toBe(true);

        const before = await runsOfCategory();
        const result = await runScheduledHarvests({ enqueue });
        const started = (await runsOfCategory()).filter(id => !before.includes(id));
        expect(started).toHaveLength(1);
        expect(result.runs).toContain(started[0]);
        expect(enqueue).toHaveBeenCalledWith(started[0]);
    });

    it('does not stack a run on one that is still going', async () => {
        const before = await runsOfCategory();
        const result = await runScheduledHarvests({ enqueue });
        expect(await runsOfCategory()).toEqual(before);
        expect(result.skipped).toBeGreaterThanOrEqual(1);
    });

    it('does nothing without an llm key', async () => {
        assertConfigured.mockImplementationOnce(() => { throw httpError(503, 'LLM is not configured'); });
        expect(await runScheduledHarvests({ enqueue })).toMatchObject({ started: 0, reason: 'llm not configured' });
    });
});
