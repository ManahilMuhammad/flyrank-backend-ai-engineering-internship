import express from 'express';
import { z } from 'zod';
import { validateBody, uuid } from '../middleware/validate.js';
import * as harvests from '../db/harvests.js';
import * as influence from '../db/influence.js';
import { assertConfigured } from '../lib/gemini.js';
import * as standings from '../db/standings.js';
import * as leverage from '../db/leverage.js';
import { enqueueHarvest, enqueueFetch, enqueueAudit } from '../lib/jobs.js';
import { isOwnedDomain } from '../lib/urls.js';
import { STANCES } from '../services/standingAuditor.js';
import { env } from '../config.js';

// mounted under /workspaces/:workspaceId/categories/:categoryId/runs
// after requireCategory
const router = express.Router({ mergeParams: true });

const createRunBody = z.object({
    // answers vary between calls 
    // so each query sampled several times
    samples_per_query: z.number().int().min(1).max(5).default(3)
}).strict();

const answersFilter = z.object({ query_id: uuid.optional() });

const limit = z.coerce.number().int().min(1).max(200).default(40);
const sourcesFilter = z.object({ limit, group_by: z.enum(['url', 'domain']).default('url') });
const standingsFilter = z.object({
    limit,
    stance: z.enum(STANCES).optional(),
    stale: z.enum(['true', 'false']).transform(v => v === 'true').optional()
});
const leverageFilter = z.object({ limit });
const graphFilter = z.object({
    limit,
    // pairs seen together only once are mostly sampling noise
    min_together: z.coerce.number().int().min(1).default(2)
});

// parse req.query or answer 400 with each problem
function parseQuery(schema, req, res) {
    const result = schema.safeParse(req.query);
    if (!result.success) {
        res.status(400).json({
            error: 'Invalid query parameters',
            details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
        });
        return null;
    }
    return result.data;
}

// influence only exists once a run has completed (scored at the end of the harvest)
function requireCompleted(req, res, next) {
    if (req.run.status !== 'completed') {
        return res.status(409).json({ error: `Run is ${req.run.status}; influence is available once it completes` });
    }
    next();
}

// loads runId within current category and sets req.run
async function requireRun(req, res, next) {
    const run = uuid.safeParse(req.params.runId).success
        ? await harvests.getRun(req.category.id, req.params.runId)
        : undefined;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    req.run = run;
    next();
}

// queue harvest
// runs in the background, poll GET /runs/:runId for progress
router.post('/', validateBody(createRunBody), async (req, res) => {
    assertConfigured(); // refuse now rather than fail later

    const queries = await harvests.listActiveQueries(req.category.id);
    if (!queries.length) {
        return res.status(400).json({ error: 'Category has no active queries; generate or add some first' });
    }

    let run;
    try {
        run = await harvests.createRun(req.category.id, {
            model: env.geminiModel,
            samplesPerQuery: req.body.samples_per_query
        });
    } catch (err) {
        if (err.constraint === 'harvest_runs_one_active_idx') {
            return res.status(409).json({ error: 'A harvest is already queued or running for this category' });
        }
        throw err;
    }

    try {
        await enqueueHarvest(run.id);
    } catch (err) {
        await harvests.finishRun(run.id, { status: 'failed', error: 'Could not queue the harvest' });
        throw err;
    }

    res.status(202).json(run);
});

router.get('/', async (req, res) => {
    res.json(await harvests.listRuns(req.category.id));
});

router.get('/:runId', requireRun, (req, res) => {
    res.json(req.run);
});

router.get('/:runId/answers', requireRun, async (req, res) => {
    const filter = answersFilter.safeParse(req.query);
    if (!filter.success) return res.status(400).json({ error: 'query_id must be a UUID' });
    res.json(await harvests.listAnswers(req.run.id, { queryId: filter.data.query_id }));
});

// sources ranked by influence
router.get('/:runId/sources', requireRun, requireCompleted, async (req, res) => {
    const query = parseQuery(sourcesFilter, req, res);
    if (!query) return;

    const sources = query.group_by === 'domain'
        ? await influence.listTopDomains(req.run.id, query.limit)
        : await influence.listTopSources(req.run.id, query.limit);
    res.json({ run_id: req.run.id, answers: req.run.stats.answers, group_by: query.group_by, sources });
});

// fetch (or re-check) run's top sources
// normally queued automatically when harvest completes
// pages checked recently skipped, unchanged pages keep snapshot
router.post('/:runId/fetch', requireRun, async (req, res) => {
    if (req.run.status !== 'completed') {
        return res.status(409).json({ error: `Run is ${req.run.status}; sources can be fetched once it completes` });
    }
    const jobId = await enqueueFetch(req.run.id);
    if (!jobId) return res.status(409).json({ error: 'A fetch for this run is already queued or running' });
    res.status(202).json({ run_id: req.run.id, queued: true });
});

// how each of run's top sources describes brand in influence order
router.get('/:runId/standings', requireRun, requireCompleted, async (req, res) => {
    const query = parseQuery(standingsFilter, req, res);
    if (!query) return;

    const brand = await standings.getRunBrand(req.run.id);
    const rows = await standings.listRunStandings(req.run.id, query);
    res.json({
        run_id: req.run.id,
        brand: { id: brand.id, name: brand.name },
        audit: req.run.stats.audit ?? null,
        standings: rows.map(r => ({ ...r, owned: isOwnedDomain(r.domain, brand.domains) }))
    });
});

// re-/audit run's fetched sources normally queued automatically after fetch
// pages already audited under current prompt version reused not re-sent to llm
router.post('/:runId/audit', requireRun, async (req, res) => {
    if (req.run.status !== 'completed') {
        return res.status(409).json({ error: `Run is ${req.run.status}; sources can be audited once it completes` });
    }
    assertConfigured();
    const jobId = await enqueueAudit(req.run.id);
    if (!jobId) return res.status(409).json({ error: 'An audit for this run is already queued or running' });
    res.status(202).json({ run_id: req.run.id, queued: true });
});

// ranked action list: where improving brand's standing moves most answer influence
// plus run's headline numbers and top sources that couldnt be audited
router.get('/:runId/leverage', requireRun, requireCompleted, async (req, res) => {
    const query = parseQuery(leverageFilter, req, res);
    if (!query) return;
    if (!req.run.stats.headline) {
        return res.status(409).json({ error: 'Run has not been audited yet; leverage is available once the audit finishes' });
    }

    const brand = await standings.getRunBrand(req.run.id);
    const [actions, unaudited] = await Promise.all([
        leverage.listActions(req.run.id, query.limit),
        leverage.listUnaudited(req.run.id, env.fetchTopN)
    ]);
    res.json({
        run_id: req.run.id,
        brand: { id: brand.id, name: brand.name },
        headline: req.run.stats.headline,
        actions,
        // owned pages are brand's own, not something to pitch
        // no verdict means no deficit to show
        unaudited: unaudited
            .filter(r => !isOwnedDomain(r.domain, brand.domains))
            .map(r => ({
                rank: r.rank, source_id: r.source_id, url: r.url, domain: r.domain, source_type: r.source_type,
                title: r.title, influence: r.influence, citation_rate: r.citation_rate, query_count: r.query_count,
                fetch_status: r.fetch_status, audit_note: r.audit_note
            }))
    });
});

// top sources as nodes
// plus which get cited in same answer
router.get('/:runId/graph', requireRun, requireCompleted, async (req, res) => {
    const query = parseQuery(graphFilter, req, res);
    if (!query) return;

    const [nodes, edges] = await Promise.all([
        influence.listTopSources(req.run.id, query.limit),
        influence.listCoCitations(req.run.id, query.limit, query.min_together)
    ]);
    res.json({ run_id: req.run.id, answers: req.run.stats.answers, nodes, edges });
});

export default router;
