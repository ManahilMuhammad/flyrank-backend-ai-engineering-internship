import { generateGrounded, assertConfigured } from '../lib/gemini.js';
import { generateBrowsed, assertGroqConfigured } from '../lib/groq.js';
import { withTransaction } from '../db/pool.js';
import * as harvests from '../db/harvests.js';
import { scoreRun } from '../db/influence.js';
import { env } from '../config.js';
import { mentionsAny } from '../lib/text.js';
import { canonicalizeUrl, domainOf, sourceTypeFor } from '../lib/urls.js';
import { resolveUrls } from './urlResolver.js';

// stop burning quota when every call is failing 
const MAX_CONSECUTIVE_FAILURES = 5;
// per-minute window full
const RATE_LIMIT_RETRIES = 2;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
    }, { once: true });
});

// share of the answer each chunk supports, summing to 1
// support segment backed by several chunks split evenly between them
// chunk order is not a ranking so with no supports every chunk gets equal share
export function supportShares(chunkCount, supports) {
    const weights = new Array(chunkCount).fill(0);
    for (const { chunkIndices, length } of supports) {
        const valid = chunkIndices.filter(i => Number.isInteger(i) && i >= 0 && i < chunkCount);
        for (const i of valid) weights[i] += length / valid.length;
    }
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total === 0) return weights.map(() => (chunkCount ? 1 / chunkCount : 0));
    return weights.map(w => w / total);
}

// grounded response -> one citation per distinct page
// chunks resolving to same page merged and weights added
export function buildCitations(chunks, supports, resolved) {
    const shares = supportShares(chunks.length, supports);
    const byUrl = new Map();
    let unresolved = 0;

    for (const [i, chunk] of chunks.entries()) {
        const url = chunk.uri && canonicalizeUrl(resolved.get(chunk.uri));
        if (!url) {
            unresolved++;
            continue;
        }
        const existing = byUrl.get(url);
        if (existing) {
            existing.weight += shares[i];
            continue;
        }
        const domain = domainOf(url);
        byUrl.set(url, {
            url,
            domain,
            sourceType: sourceTypeFor(domain),
            // grounding titles usually just domain
            title: chunk.title && chunk.title.replace(/^www\./, '') !== domain ? chunk.title : null,
            weight: shares[i],
            chunkIndex: i
        });
    }
    return { citations: [...byUrl.values()], unresolved };
}

// answer engines: each returns { text, chunks, supports, searchQueries } for one user question
// (looked up at call time, not import time, so module mock only needs engine it uses)
export const ENGINES = {
    gemini: prompt => generateGrounded(prompt), // google search grounding
    groq: prompt => generateBrowsed(prompt)     // open model with browser search
};

// model new run on engine will use
// throws 503 when engine has no api key
export function engineModel(engine) {
    if (engine === 'groq') {
        assertGroqConfigured();
        return env.groqModel;
    }
    assertConfigured();
    return env.geminiModel;
}

// daily quota running out mid-run pauses run until it resets
// instead of failing it
const PAUSE_IF_RETRY_AFTER_SECONDS = 5 * 60;

// ask one query once and store answer with citations
async function harvestSample({ run, query, sampleN, brandTerms, counts }) {
    const answer = await ENGINES[run.engine](query.text);
    const resolved = await resolveUrls(answer.chunks.map(c => c.uri).filter(Boolean), counts.redirects);
    const { citations, unresolved } = buildCitations(answer.chunks, answer.supports, resolved);
    counts.unresolved_chunks += unresolved;
    counts.invalid_citations += answer.invalidCitations ?? 0;
    counts.engine_tokens += answer.tokens ?? 0;

    await withTransaction(client => harvests.saveAnswer(client, {
        runId: run.id,
        queryId: query.id,
        sampleN,
        text: answer.text,
        brandMentioned: mentionsAny(answer.text, brandTerms),
        searchQueries: answer.searchQueries,
        engineResponse: answer.raw ?? null,
        citations
    }));
}

// execute queued run: every active query x samples_per_query grounded calls
// calls go sample by sample so runs cut short still cover every query
// returns { status: 'completed' | 'failed' } or { status: 'paused', resumeAt } when daily quota ran out
// ({ status: null } if there was nothing to do)
export async function runHarvest(runId, { signal, minIntervalMs = env.harvestMinIntervalMs, rateLimitPauseMs = 60_000 } = {}) {
    const run = await harvests.getRunForWorker(runId);
    if (!run) {
        console.warn(`Harvest ${runId} no longer exists, skipping`);
        return { status: null };
    }
    if (!(await harvests.markRunning(runId))) {
        console.warn(`Harvest ${runId} is already ${run.status}, skipping`);
        return { status: null };
    }

    const startedAt = run.started_at ?? new Date();
    const brandTerms = [run.brand_name, ...run.brand_aliases];
    const queries = await harvests.listActiveQueries(run.category_id);
    const done = await harvests.listDoneSamples(runId);

    const counts = {
        queries: queries.length,
        samples_per_query: run.samples_per_query,
        calls_planned: queries.length * run.samples_per_query,
        calls_done: done.size,
        calls_failed: 0,
        rate_limit_pauses: 0,
        unresolved_chunks: 0,
        invalid_citations: 0,
        engine_tokens: 0,
        redirects: { cached: 0, resolved: 0, failed: 0 }
    };

    let consecutiveFailures = 0;
    let lastCallAt = 0;
    let fatalError = null;
    let pauseUntil = null;

    outer:
    for (let sampleN = 1; sampleN <= run.samples_per_query; sampleN++) {
        for (const query of queries) {
            if (done.has(`${query.id}:${sampleN}`)) continue;

            for (let attempt = 0; ; attempt++) {
                // pace calls to stay under the per-minute quota
                await sleep(Math.max(0, lastCallAt + minIntervalMs - Date.now()), signal);
                lastCallAt = Date.now();
                try {
                    await harvestSample({ run, query, sampleN, brandTerms, counts });
                    counts.calls_done++;
                    consecutiveFailures = 0;
                } catch (err) {
                    if (err.status === 429 && err.retryAfterSeconds >= PAUSE_IF_RETRY_AFTER_SECONDS) {
                        pauseUntil = new Date(Date.now() + (err.retryAfterSeconds + 60) * 1000);
                        break outer;
                    }
                    if (err.status === 429 && attempt < RATE_LIMIT_RETRIES) {
                        counts.rate_limit_pauses++;
                        console.warn(`Harvest ${runId}: rate limited, pausing ${rateLimitPauseMs / 1000}s`);
                        await sleep(rateLimitPauseMs, signal);
                        continue;
                    }
                    if (!err.expose) throw err; 
                    counts.calls_failed++;
                    consecutiveFailures++;
                    console.warn(`Harvest ${runId}: query ${query.id} sample ${sampleN} failed: ${err.message}`);
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        fatalError = `Stopped after ${MAX_CONSECUTIVE_FAILURES} failed calls in a row: ${err.message}`;
                        break outer;
                    }
                }
                break;
            }
            await harvests.updateStats(runId, counts);
        }
    }

    if (pauseUntil) {
        // still 'running': job queue re-runs at paused_until and resumes from saved answers
        await harvests.updateStats(runId, { ...counts, paused_until: pauseUntil.toISOString() });
        console.log(`Harvest ${runId} paused until ${pauseUntil.toISOString()} (daily quota): ${counts.calls_done}/${counts.calls_planned} done`);
        return { status: 'paused', resumeAt: pauseUntil };
    }

    const totals = await harvests.computeRunTotals(runId, run.category_id);
    const stats = {
        ...counts,
        ...totals,
        brand_mention_rate: totals.answers ? Number((totals.brand_mentions / totals.answers).toFixed(3)) : null,
        duration_seconds: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)
    };

    // a run with nothing stored isn't a result, even if it never hit the consecutive-failure limit
    if (!fatalError && totals.answers === 0 && counts.calls_failed > 0) {
        fatalError = `Every call failed (${counts.calls_failed}), no answers stored`;
    }

    // scored before being marked completed
    // so completed run always has influence ranking
    if (!fatalError) await scoreRun(runId);

    const status = fatalError ? 'failed' : 'completed';
    await harvests.finishRun(runId, { status, stats, error: fatalError });
    console.log(`Harvest ${runId} ${status}: ${totals.answers} answers, ` +
        `${totals.unique_sources} sources, ${counts.calls_failed} failed calls`);
    return { status };
}
