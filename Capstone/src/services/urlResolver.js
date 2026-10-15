import { pool } from '../db/pool.js';

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
const TIMEOUT_MS = 10_000;

export function isGroundingRedirect(uri) {
    try {
        return new URL(uri).hostname === REDIRECT_HOST;
    } catch {
        return false;
    }
}

// redirect points straight at cited page
// never follow it so slow or hostile pages cant stall the harvest
async function followRedirect(uri) {
    try {
        const res = await fetch(uri, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'User-Agent': 'Priors/0.1 (citation source research)' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) return new URL(location, uri).href;
        console.warn(`Grounding redirect returned ${res.status} without a location`);
        return null;
    } catch (err) {
        console.warn('Grounding redirect failed: ', err.name === 'TimeoutError' ? 'timeout' : err.message);
        return null;
    }
}

// map each grounding uri to real page url (null if couldnt be resolved)
// counts go into run stats so resolver problem is visible
export async function resolveUrls(uris, counts = { cached: 0, resolved: 0, failed: 0 }) {
    const redirects = [...new Set(uris.filter(isGroundingRedirect))];
    const resolved = new Map(uris.filter(u => !isGroundingRedirect(u)).map(u => [u, u]));
    if (!redirects.length) return resolved;

    const { rows } = await pool.query(
        'SELECT redirect_url, resolved_url FROM url_resolutions WHERE redirect_url = ANY($1)',
        [redirects]
    );
    for (const row of rows) {
        resolved.set(row.redirect_url, row.resolved_url);
        counts.cached++;
    }

    const misses = redirects.filter(u => !resolved.has(u));
    const results = await Promise.all(misses.map(followRedirect));
    for (const [i, uri] of misses.entries()) {
        resolved.set(uri, results[i]);
        if (!results[i]) {
            counts.failed++;
            continue; // not cached, failure may be transient
        }
        counts.resolved++;
        await pool.query(
            `INSERT INTO url_resolutions (redirect_url, resolved_url) VALUES ($1, $2)
             ON CONFLICT (redirect_url) DO UPDATE SET resolved_url = EXCLUDED.resolved_url, resolved_at = now()`,
            [uri, results[i]]
        );
    }
    return resolved;
}
