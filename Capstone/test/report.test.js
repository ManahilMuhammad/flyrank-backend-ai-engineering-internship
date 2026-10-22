import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// needs docker compose stack: postgres, mailpit (smtp 1025, api 8025) to receive real emails

const USERS = {
    'token-p': { id: '00000000-0000-4000-8000-000000000019', email: 'owner-p@test.local' },
    'token-q': { id: '00000000-0000-4000-8000-000000000020', email: 'q@test.local' }
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
    enqueueAudit: vi.fn(async () => 'job-id'),
    enqueueReport: vi.fn(async () => 'job-id')
}));

const { generateJson, generateGrounded } = await import('../src/lib/gemini.js');
const { enqueueReport } = await import('../src/lib/jobs.js');
const { summaryParagraph, describeShift, pdfSafe, generateReport } = await import('../src/services/report.js');
const { auditRunSources } = await import('../src/services/standingAuditor.js');
const { detectShifts } = await import('../src/services/shifts.js');
const { runHarvest } = await import('../src/services/harvester.js');
const snapshots = await import('../src/db/snapshots.js');
const { contentHash } = await import('../src/lib/extract.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asP = { Authorization: 'Bearer token-p' };
const asQ = { Authorization: 'Bearer token-q' };
const MAILPIT = process.env.MAILPIT_API || 'http://localhost:8025';

// --> wording 

const headline = over => ({
    answers: 180, brand_mention_rate: 0.12, owned_citation_rate: 0.03, grounded_answer_rate: 0.95, sources: 90,
    top5_concentration: 0.41, owned_influence_share: 0.02, audit_coverage: 0.82,
    stance_mix: { absent: 0.55, neutral: 0.2, favorable: 0.2, unfavorable: 0.05 }, stale_share: 0.09, total_leverage: 0.3, ...over
});
const data = over => ({
    engine: 'Gemini', brand: 'FlyRank', headline: headline(), prevHeadline: null, prevDate: null,
    actions: [{ action: 'correct_stale_info', domain: 'capterra.com' }], shifts: [], ...over
});

describe('summaryParagraph', () => {
    it('states the run\'s numbers in plain words', () => {
        expect(summaryParagraph(data())).toBe(
            'Gemini named FlyRank in 12% of 180 answers. 3% of answers cited FlyRank\'s own pages. ' +
            'The 5 most influential pages carry 41% of all citation influence. ' +
            'Of the third-party influence we could audit (82% of it), 55% never mentions FlyRank and 9% repeats outdated facts. ' +
            'Top fix: ask them to correct outdated facts on capterra.com. ' +
            'This is the first audited run, so there is nothing to compare with yet.'
        );
    });

    it('compares with the previous run when there is one', () => {
        const s = summaryParagraph(data({
            prevHeadline: headline({ brand_mention_rate: 0.17 }), prevDate: '2026-10-12', shifts: [{}, {}]
        }));
        expect(s).toContain('in 12% of 180 answers (down 5 points since 2026-10-12)');
        expect(s).toContain('2 changes since the previous run.');
    });
});

describe('describeShift', () => {
    it('puts each event in words', () => {
        expect(describeShift({ type: 'source_entered', domain: 'g2.com', payload: { citation_rate: 0.4 } }))
            .toBe('New source: g2.com is now cited in 40% of answers.');
        expect(describeShift({ type: 'source_exited', domain: 'old.com', payload: { previous_citation_rate: 0.2 } }))
            .toBe('Dropped out: old.com (was cited in 20% of answers).');
        expect(describeShift({
            type: 'standing_changed', domain: 'blog.com',
            payload: { from: { stance: 'favorable', is_stale: false }, to: { stance: 'favorable', is_stale: true } }
        })).toBe('blog.com now describes the brand as favorable, with outdated facts (was favorable).');
        expect(describeShift({ type: 'citation_rate_changed', source_id: null, payload: { metric: 'brand_mention_rate', from: 0.3, to: 0.2 } }))
            .toBe('Brand mention rate: 30% -> 20%.');
    });
});

describe('pdfSafe', () => {
    it('keeps what the pdf font can print and replaces the rest', () => {
        expect(pdfSafe('Café “quoted” — 5€ ✓ → 日本')).toBe('Café “quoted” — 5€ ? ? ??');
    });
});

// --> full run, reported and emailed

const PAGES = {
    stale: { url: 'https://a.report-test.dev/best-geo-tools', share: 60, text: 'Best tools\nFlyRank is our top pick and starts at $1,499 per month.' },
    missing: { url: 'https://b.report-test.dev/roundup', share: 30, text: 'Roundup\nPeec AI and Profound lead the market.' },
    blocked: { url: 'https://c.report-test.dev/reviews', share: 10, text: null }
};
let ws, category, run, emptyRun;
const ids = {};
const runUrl = id => `/workspaces/${ws.id}/categories/${category.id}/runs/${id}`;

async function mailpitSearch(query) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}`);
    return (await res.json()).messages ?? [];
}

beforeAll(async () => {
    await migrate();
    ws = (await request(app).post('/workspaces').set(asP).send({ name: 'P workspace' })).body;
    await request(app).post('/workspaces').set(asQ).send({ name: 'Q workspace' });
    const brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asP)
        .send({ name: 'FlyRank', fact_sheet: { pricing_usd_per_month: { Sparrow: 1999 } } })).body;
    category = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asP)
        .send({ brand_id: brand.id, name: 'GEO tools' })).body;
    await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/queries`).set(asP)
        .send({ queries: [{ text: 'best geo tools' }] });

    const pages = Object.values(PAGES);
    generateGrounded.mockResolvedValue({
        text: 'FlyRank is one option.', chunks: pages.map(p => ({ uri: p.url, title: null })),
        supports: pages.map((p, i) => ({ chunkIndices: [i], length: p.share })), searchQueries: [], model: 'test-model'
    });
    generateJson.mockResolvedValue({
        data: { stance: 'favorable', is_stale: true, stale_reason: 'Says $1,499; fact sheet says $1,999',
            evidence_passage: 'FlyRank is our top pick and starts at $1,499 per month.', confidence: 0.9 },
        model: 'test-model'
    });

    run = (await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/runs`).set(asP).send({ samples_per_query: 1 })).body;
    await runHarvest(run.id, { minIntervalMs: 0 });
    const { rows } = await pool.query('SELECT id, url_canonical FROM sources WHERE url_canonical = ANY($1)', [pages.map(p => p.url)]);
    for (const [key, page] of Object.entries(PAGES)) {
        ids[key] = rows.find(r => r.url_canonical === page.url).id;
        const snapshot = page.text === null
            ? { id: await snapshots.saveFailedSnapshot(ids[key], { status: 'fetch_failed', httpStatus: 403, error: 'HTTP 403' }) }
            : await snapshots.saveTextSnapshot(ids[key], { hash: contentHash(page.text), text: page.text, httpStatus: 200, finalUrl: page.url });
        await snapshots.linkSnapshot(run.id, ids[key], snapshot.id);
    }
    await auditRunSources(run.id, { minIntervalMs: 0 });
    await detectShifts(run.id);

    // completed run that was never audited
    emptyRun = (await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/runs`).set(asP).send({ samples_per_query: 1 })).body;
    await runHarvest(emptyRun.id, { minIntervalMs: 0 });
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-p'].id, USERS['token-q'].id]]
    );
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [Object.values(ids)]);
    await pool.end();
});

describe('emailing the report', () => {
    it('sends the pdf to the category\'s recipients, and it arrives in mailpit', async () => {
        const recipient = `report-${Date.now()}@priors.test`;
        await request(app).patch(`/workspaces/${ws.id}/categories/${category.id}`).set(asP).send({ report_recipients: [recipient] });

        expect(await generateReport(run.id)).toEqual({ generated: true, recipients: [recipient], emailed: true });

        const [message] = await mailpitSearch(`to:"${recipient}"`);
        expect(message.Subject).toMatch(/^Priors report: FlyRank in GEO tools \(\d{4}-\d{2}-\d{2}\)$/);
        const full = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
        expect(full.Attachments).toHaveLength(1);
        expect(full.Attachments[0]).toMatchObject({ ContentType: 'application/pdf' });
        expect(full.Attachments[0].FileName).toMatch(/^priors-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf$/);
        expect(full.Text).toContain('Top fix: ask them to correct outdated facts on a.report-test.dev.');
        expect(full.Text).toContain('1. a.report-test.dev: ask them to correct outdated facts');
    });

    it('records who it went to', async () => {
        const res = await request(app).get(`${runUrl(run.id)}/report`).set(asP);
        expect(res.status).toBe(200);
        expect(res.body.recipients).toHaveLength(1);
        expect(res.body.emailed_at).not.toBeNull();
        expect(res.body.email_error).toBeNull();
        expect(res.body.size_bytes).toBeGreaterThan(1000);
        expect(res.body).not.toHaveProperty('pdf');
    });

    it('falls back to the workspace owner\'s login email', async () => {
        await request(app).patch(`/workspaces/${ws.id}/categories/${category.id}`).set(asP).send({ report_recipients: [] });
        const before = (await mailpitSearch('to:"owner-p@test.local"')).length;
        expect(await generateReport(run.id)).toMatchObject({ emailed: true, recipients: ['owner-p@test.local'] });
        expect((await mailpitSearch('to:"owner-p@test.local"')).length).toBe(before + 1);
    });

    it('keeps the pdf but records the problem when there is nobody to send to', async () => {
        await pool.query('UPDATE workspace_members SET email = NULL WHERE workspace_id = $1', [ws.id]);
        expect(await generateReport(run.id)).toMatchObject({ generated: true, emailed: false, error: 'no recipients' });
        const res = await request(app).get(`${runUrl(run.id)}/report`).set(asP);
        expect(res.body).toMatchObject({ emailed_at: null, email_error: 'no recipients: set report_recipients on the category' });

        // the next request through the workspace restores the member's email from their login
        await request(app).get(`/workspaces/${ws.id}`).set(asP);
        const { rows } = await pool.query('SELECT email FROM workspace_members WHERE workspace_id = $1', [ws.id]);
        expect(rows[0].email).toBe('owner-p@test.local');
    });
});

describe('report routes', () => {
    it('serves the pdf', async () => {
        const res = await request(app).get(`${runUrl(run.id)}/report.pdf`).set(asP).buffer(true)
            .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('builds the pdf on first request for an audited run without emailing it', async () => {
        await pool.query('DELETE FROM reports WHERE run_id = $1', [run.id]);
        expect((await request(app).get(`${runUrl(run.id)}/report.pdf`).set(asP)).status).toBe(200);
        expect((await request(app).get(`${runUrl(run.id)}/report`).set(asP)).body.emailed_at).toBeNull();
    });

    it('refuses for a run that was never audited', async () => {
        expect((await request(app).get(`${runUrl(emptyRun.id)}/report.pdf`).set(asP)).status).toBe(409);
        expect((await request(app).post(`${runUrl(emptyRun.id)}/report`).set(asP)).status).toBe(409);
        expect((await request(app).get(`${runUrl(emptyRun.id)}/report`).set(asP)).status).toBe(404);
    });

    it('queues a resend', async () => {
        const res = await request(app).post(`${runUrl(run.id)}/report`).set(asP);
        expect(res.status).toBe(202);
        expect(enqueueReport).toHaveBeenCalledWith(run.id);
    });

    it('validates report_recipients', async () => {
        const res = await request(app).patch(`/workspaces/${ws.id}/categories/${category.id}`).set(asP).send({ report_recipients: ['nope'] });
        expect(res.status).toBe(400);
    });

    it('is invisible to another tenant', async () => {
        expect((await request(app).get(`${runUrl(run.id)}/report.pdf`).set(asQ)).status).toBe(404);
        expect((await request(app).post(`${runUrl(run.id)}/report`).set(asQ)).status).toBe(404);
    });
});
