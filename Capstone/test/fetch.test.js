import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import request from 'supertest';

// different fake users from other test files (run in parallel)
const USERS = {
    'token-i': { id: '00000000-0000-4000-8000-000000000012', email: 'i@test.local' }
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

const { generateGrounded } = await import('../src/lib/gemini.js');
const { enqueueFetch } = await import('../src/lib/jobs.js');
const { runHarvest } = await import('../src/services/harvester.js');
const { fetchRunSources } = await import('../src/services/sourceFetcher.js');
const { fetchPage } = await import('../src/lib/fetchPage.js');
const { extractText, contentHash } = await import('../src/lib/extract.js');
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { pool } = await import('../src/db/pool.js');

const app = createApp();
const asI = { Authorization: 'Bearer token-i' };
const LOCAL = { allowPrivateHosts: true, domainDelayMs: 0 }; // test server on localhost

const paragraph = n => `<p>Paragraph ${n} of a long review of generative engine optimization tools. ` +
    'It compares pricing, engine coverage and reporting across vendors, and notes that FlyRank starts at ' +
    '$1,499 per month according to an older pricing page that has not been updated in a while.</p>';
const articlePage = (extra = '') => `<!doctype html><html><head><title>Best GEO tools 2026</title></head><body>
    <nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/login">Log in</a></nav>
    <aside>${extra}</aside>
    <article><h1>Best GEO tools 2026</h1>${[1, 2, 3, 4].map(paragraph).join('')}</article>
    <footer>Copyright Example Media</footer></body></html>`;

// small site: robots.txt
// pages that support conditional requests, change, redirect, fail
let server, base, version = 1, noise = 0;
const hits = {};
function handler(req, res) {
    const path = req.url;
    if (path !== '/robots.txt') hits[path] = (hits[path] ?? 0) + 1;
    const html = body => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

    switch (path) {
        case '/robots.txt':
            res.writeHead(200, { 'content-type': 'text/plain' });
            return res.end('User-agent: *\nDisallow: /private/\n');
        case '/article':
            if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end(); }
            res.writeHead(200, { 'content-type': 'text/html', etag: '"v1"' });
            return res.end(articlePage());
        case '/noisy': // same article with different sidebar every time = not real change
            return html(articlePage(`<p>Ad ${++noise}: rendered at ${Date.now()}</p>`));
        case '/changing':
            return html(articlePage().replace('Paragraph 1 of', `Version ${version} of`));
        case '/old-url':
            res.writeHead(301, { location: '/new-url' });
            return res.end();
        case '/new-url':
            return html(articlePage().replace('Best GEO tools 2026', 'Moved review'));
        case '/report.pdf':
            res.writeHead(200, { 'content-type': 'application/pdf' });
            return res.end('%PDF-1.4');
        case '/app': // client-rendered page: nothing to read without js
            return html('<html><body><div id="root"></div><script>render()</script></body></html>');
        default:
            res.writeHead(404);
            return res.end('not found');
    }
}

const urlFor = path => `${base}${path}`;
let ws, category, run, ids;

async function snapshotsOf(path) {
    const { rows } = await pool.query(
        `SELECT sn.* FROM source_snapshots sn JOIN sources s ON s.id = sn.source_id
         WHERE s.url_canonical = $1 ORDER BY sn.checked_at`,
        [urlFor(path)]
    );
    return rows;
}

beforeAll(async () => {
    await migrate();
    server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const pages = ['/article', '/noisy', '/changing', '/old-url', '/private/page', '/report.pdf', '/app', '/missing']
        .map(urlFor)
        .concat('https://www.youtube.com/watch?v=priors-test');
    generateGrounded.mockResolvedValue({
        text: 'answer',
        chunks: pages.map(uri => ({ uri, title: null })),
        supports: pages.map((_, i) => ({ chunkIndices: [i], length: 10 })),
        searchQueries: [],
        model: 'test-model'
    });

    ws = (await request(app).post('/workspaces').set(asI).send({ name: 'I workspace' })).body;
    const brand = (await request(app).post(`/workspaces/${ws.id}/brands`).set(asI).send({ name: 'FlyRank' })).body;
    category = (await request(app).post(`/workspaces/${ws.id}/categories`).set(asI)
        .send({ brand_id: brand.id, name: 'GEO tools' })).body;
    await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/queries`).set(asI)
        .send({ queries: [{ text: 'best geo tools' }] });
    run = (await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/runs`).set(asI)
        .send({ samples_per_query: 1 })).body;
    await runHarvest(run.id, { minIntervalMs: 0 });
});

afterAll(async () => {
    await pool.query(
        'DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ANY($1))',
        [[USERS['token-i'].id]]
    );
    await pool.query(`DELETE FROM sources WHERE url_canonical LIKE $1 OR url_canonical LIKE '%v=priors-test'`, [`${base}%`]);
    server.close();
    await pool.end();
});

describe('extractText', () => {
    it('keeps the article, one line per paragraph, and drops navigation and footer', () => {
        const { title, text } = extractText(articlePage(), { url: 'https://example.com/a' });
        expect(title).toBe('Best GEO tools 2026');
        expect(text).toContain('starts at $1,499 per month');
        expect(text.split('\n').filter(l => l.startsWith('Paragraph'))).toHaveLength(4);
        expect(text).not.toContain('Log in');
        expect(text).not.toContain('Copyright');
    });

    it('hashes text, not markup', () => {
        const a = extractText(articlePage('<p>Ad 1</p>'), { url: 'https://example.com/a' }).text;
        const b = extractText(articlePage('<p>Ad 2</p>'), { url: 'https://example.com/a' }).text;
        expect(contentHash(a)).toBe(contentHash(b));
    });

    it('reads plain text as is', () => {
        expect(extractText('line one\r\n\r\n  line   two ', { contentType: 'text/plain' }).text).toBe('line one\nline two');
    });
});

describe('fetchPage', () => {
    it('refuses private addresses unless allowed', async () => {
        const res = await fetchPage(urlFor('/article'));
        expect(res).toMatchObject({ status: 'fetch_failed', error: 'refusing to fetch a private address' });
        expect(hits['/article']).toBeUndefined();
    });
});

describe('fetching a run\'s sources', () => {
    it('stores readable pages and records why the others were not read', async () => {
        const stats = await fetchRunSources(run.id, LOCAL);
        expect(stats).toMatchObject({
            selected: 9,
            new: 4,             // article, noisy, changing, old-url (followed to new-url)
            blocked_robots: 1,  // /private/page
            unsupported: 3,     // pdf, client-rendered page, youtube (never requested)
            fetch_failed: 1,    // 404
            needs_audit: 4
        });
        expect(hits['/private/page']).toBeUndefined();

        const [article] = await snapshotsOf('/article');
        expect(article).toMatchObject({ fetch_status: 'ok', http_status: 200, etag: '"v1"' });
        expect(article.extracted_text).toContain('according to an older pricing page');
        expect(article.content_hash).toHaveLength(64);

        const [moved] = await snapshotsOf('/old-url');
        expect(moved.final_url).toBe(urlFor('/new-url'));
        expect((await snapshotsOf('/missing'))[0]).toMatchObject({ fetch_status: 'fetch_failed', http_status: 404, error: 'HTTP 404' });
        expect((await snapshotsOf('/app'))[0].error).toBe('no readable text (page may need javascript)');
    });

    it('fills in page titles and shows fetch status on the ranked sources', async () => {
        const res = await request(app).get(`/workspaces/${ws.id}/categories/${category.id}/runs/${run.id}/sources`).set(asI);
        const byUrl = Object.fromEntries(res.body.sources.map(s => [s.url, s]));
        expect(byUrl[urlFor('/article')]).toMatchObject({ title: 'Best GEO tools 2026', fetch_status: 'ok', fetch_error: null });
        expect(byUrl[urlFor('/private/page')].fetch_status).toBe('blocked_robots');

        const run1 = (await request(app).get(`/workspaces/${ws.id}/categories/${category.id}/runs/${run.id}`).set(asI)).body;
        expect(run1.stats.fetch).toMatchObject({ selected: 9, new: 4 });
        expect(run1.stats.answers).toBe(1); // harvest stats kept alongside
    });

    it('makes zero requests when run again within the freshness window', async () => {
        const before = { ...hits };
        const stats = await fetchRunSources(run.id, LOCAL);
        expect(stats).toMatchObject({ selected: 9, skipped_fresh: 9, needs_audit: 0 });
        expect(hits).toEqual(before);
    });

    it('re-checks stale pages without storing unchanged text again', async () => {
        version = 2;
        const stats = await fetchRunSources(run.id, { ...LOCAL, ttlHours: 0 });
        expect(stats).toMatchObject({
            not_modified: 1, // article answered 304 to its etag
            unchanged: 2,    // noisy (only ad changed) and old-url
            changed: 1,      // changing: paragraph edited
            needs_audit: 1
        });

        expect(await snapshotsOf('/article')).toHaveLength(1);
        expect(await snapshotsOf('/noisy')).toHaveLength(1);
        const changing = await snapshotsOf('/changing');
        expect(changing).toHaveLength(2);
        expect(changing[1].extracted_text).toContain('Version 2 of');
    });

    it('links each scored source to the snapshot it was read from', async () => {
        const { rows } = await pool.query(
            `SELECT s.url_canonical, sn.extracted_text FROM source_scores ss
             JOIN sources s ON s.id = ss.source_id JOIN source_snapshots sn ON sn.id = ss.snapshot_id
             WHERE ss.run_id = $1`,
            [run.id]
        );
        expect(rows).toHaveLength(9);
        const changing = rows.find(r => r.url_canonical === urlFor('/changing'));
        expect(changing.extracted_text).toContain('Version 2 of');
    });
});

describe('fetch route', () => {
    const fetchUrl = id => `/workspaces/${ws.id}/categories/${category.id}/runs/${id}/fetch`;

    it('queues a fetch for a completed run', async () => {
        const res = await request(app).post(fetchUrl(run.id)).set(asI);
        expect(res.status).toBe(202);
        expect(enqueueFetch).toHaveBeenCalledWith(run.id);
    });

    it('refuses when one is already queued', async () => {
        enqueueFetch.mockResolvedValueOnce(null);
        expect((await request(app).post(fetchUrl(run.id)).set(asI)).status).toBe(409);
    });

    it('refuses for a run that has not completed', async () => {
        const queued = (await request(app).post(`/workspaces/${ws.id}/categories/${category.id}/runs`).set(asI).send({})).body;
        const res = await request(app).post(fetchUrl(queued.id)).set(asI);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('Run is queued; sources can be fetched once it completes');
    });
});
