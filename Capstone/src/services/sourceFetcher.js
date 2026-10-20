import { env } from '../config.js';
import * as snapshots from '../db/snapshots.js';
import { fetchPage, isUnsupportedDomain } from '../lib/fetchPage.js';
import { extractText, contentHash } from '../lib/extract.js';

// failed fetch retried sooner than page successfully read
const FAILED_TTL_HOURS = 24;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// fetch one source unless already recent enough
// returns outcome name
// outcome links run's score to snapshot that describes page
async function processSource(runId, source, ctx) {
    const ttlHours = source.latest_status === 'fetch_failed' ? Math.min(FAILED_TTL_HOURS, ctx.ttlHours) : ctx.ttlHours;
    const ageMs = source.latest_checked_at ? Date.now() - new Date(source.latest_checked_at).getTime() : Infinity;
    if (ageMs < ttlHours * 3600_000) {
        await snapshots.linkSnapshot(runId, source.id, source.latest_id);
        return 'skipped_fresh';
    }

    if (isUnsupportedDomain(source.domain)) {
        const id = await snapshots.saveFailedSnapshot(source.id, { status: 'unsupported', error: 'site needs a browser or an api' });
        await snapshots.linkSnapshot(runId, source.id, id);
        return 'unsupported';
    }

    const page = await fetchPage(source.url, {
        etag: source.ok_etag,
        lastModified: source.ok_last_modified,
        robotsCache: ctx.robotsCache,
        allowPrivateHosts: ctx.allowPrivateHosts
    });

    if (page.status === 'not_modified' && source.ok_id) {
        await snapshots.touchSnapshot(source.ok_id, { httpStatus: 304 });
        await snapshots.linkSnapshot(runId, source.id, source.ok_id);
        return 'not_modified';
    }

    if (page.status === 'ok') {
        const { title, text } = extractText(page.body, { url: page.finalUrl, contentType: page.contentType });
        if (text) {
            const saved = await snapshots.saveTextSnapshot(source.id, {
                hash: contentHash(text),
                text,
                httpStatus: page.httpStatus,
                finalUrl: page.finalUrl,
                etag: page.etag,
                lastModified: page.lastModified
            });
            if (title) await snapshots.fillSourceTitle(source.id, title);
            await snapshots.linkSnapshot(runId, source.id, saved.id);
            if (!saved.inserted) return 'unchanged';
            return source.ok_id ? 'changed' : 'new';
        }
        page.status = 'unsupported';
        page.error = 'no readable text (page may need javascript)';
    }

    const status = page.status === 'not_modified' ? 'fetch_failed' : page.status; // 304 with nothing stored
    const id = await snapshots.saveFailedSnapshot(source.id, {
        status,
        httpStatus: page.httpStatus,
        finalUrl: page.finalUrl,
        error: page.error ?? (page.status === 'not_modified' ? '304 without a stored copy' : null)
    });
    await snapshots.linkSnapshot(runId, source.id, id);
    return status;
}

// fetch run's top sources: several sites at once (one request per site)
// returns stats also stored on run
export async function fetchRunSources(runId, {
    topN = env.fetchTopN,
    ttlHours = env.fetchTtlHours,
    allowPrivateHosts = false,
    concurrency = 4,
    domainDelayMs = 1000
} = {}) {
    const startedAt = Date.now();
    const sources = await snapshots.listSourcesToFetch(runId, topN);
    const ctx = { ttlHours, allowPrivateHosts, robotsCache: new Map() };

    const counts = {
        selected: sources.length,
        new: 0, changed: 0, unchanged: 0, not_modified: 0, skipped_fresh: 0,
        fetch_failed: 0, blocked_robots: 0, unsupported: 0
    };

    const byDomain = new Map();
    for (const source of sources) {
        if (!byDomain.has(source.domain)) byDomain.set(source.domain, []);
        byDomain.get(source.domain).push(source);
    }
    const queue = [...byDomain.values()];

    async function worker() {
        for (let group = queue.shift(); group; group = queue.shift()) {
            for (const [i, source] of group.entries()) {
                const outcome = await processSource(runId, source, ctx);
                counts[outcome]++;
                // politeness gap between real requests to same site
                const requested = !['skipped_fresh', 'unsupported'].includes(outcome);
                if (requested && i < group.length - 1) await sleep(domainDelayMs);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

    const stats = {
        ...counts,
        // pages with new text
        needs_audit: counts.new + counts.changed,
        duration_seconds: Math.round((Date.now() - startedAt) / 1000),
        finished_at: new Date().toISOString()
    };
    await snapshots.saveFetchStats(runId, stats);
    console.log(`Fetch for run ${runId}: ${JSON.stringify(counts)}`);
    return stats;
}
